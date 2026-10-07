# Native production comparison. Outputs stay in ignored tmp; never benchmarks a stub app.
require_relative "support"
require_relative "http_client"
require "digest"
require "stringio"
require "zlib"
require "time"
include BenchmarkSupport

repo = File.expand_path("..", __dir__)
workspace = File.dirname(repo)
work = File.join(repo, "tmp/bench")
options = { apps: "express,express-bun,rust", rounds: 2, duration: 4, concurrencies: "16", port: 25130,
  seed: File.join(workspace, "once-campfire-rust/parity/.seed/default"), preflight: false,
  loadgen: ENV.fetch("LOADGEN", File.join(workspace, "once-campfire-rust/bench/loadgen/target/release/loadgen")),
  env_file: ENV.fetch("BENCH_ENV_FILE", File.join(workspace, "once-campfire-rust/parity/.env.reference")),
  output: File.join(work, "results"), cpus: "8-11", client_cpus: "12-15", suites: "http", cable_clients: "100,500,1000", cable_tput_secs: 15, routes: "room_show,messages_page,sidebar,search,avatar,static_css,up,post_message" }
OptionParser.new do |parser|
  options.each do |key, default|
    if [true, false].include?(default)
      parser.on("--#{key}") { options[key] = true }
    else
      type = default.is_a?(Integer) ? Integer : String
      parser.on("--#{key.to_s.tr('_', '-')} VALUE", type) { |value| options[key] = value }
    end
  end
  parser.on("--help") { puts parser; exit }
end.parse!
raise "use an even number of rounds" unless options[:rounds].positive? && options[:rounds].even?
apps = options[:apps].split(",")
raise "unknown app" unless (apps - %w[express express-bun rust]).empty?
# express-bun is the same Express source built from Dockerfile.bun; only the runtime differs.
runtimes = { "express" => "node", "express-bun" => "bun", "rust" => "rust" }
env_name = ->(app) { app.upcase.tr("-", "_") }
labels = JSON.parse(File.read(File.join(options[:seed], "labels.json")))
original_seed_sha = Digest::SHA256.file(File.join(options[:seed], "db/production.sqlite3")).hexdigest
room = Integer(labels.fetch("rooms.watercooler"))
write_room = Integer(labels.fetch("rooms.hq"))
base = "http://127.0.0.1:#{options[:port]}"
fixture_env = File.readlines(options[:env_file], chomp: true).reject { |line| line.empty? || line.start_with?("#") }.to_h { |line| line.split("=", 2) }
lg = ->(*args) do
  if ENV["LOADGEN_DEBUG"]
    output, errors, status = Open3.capture3("taskset", "-c", options[:client_cpus], options[:loadgen], *args)
    File.open(File.join(work, "loadgen-debug-#{Process.pid}.log"), "ab") { |file| file.write(errors) }
    raise "load generator failed" unless status.success?
    JSON.parse(output)
  else
    JSON.parse(run("taskset", "-c", options[:client_cpus], options[:loadgen], *args))
  end
end
container = "cf-native-bench-#{Process.pid}"
results = []
expected_message_ids = {}
metadata = { started_at: Time.now.utc.iso8601, seed_sha256: original_seed_sha, server_cpus: options[:cpus],
  client_cpus: options[:client_cpus], network: "host", gzip: true, duration: options[:duration],
  concurrencies: options[:concurrencies], rounds: options[:rounds], loadgen_sha256: Digest::SHA256.file(options[:loadgen]).hexdigest,
  suites: options[:suites], routes: options[:routes], cable_clients: options[:cable_clients], cable_tput_secs: options[:cable_tput_secs], images: {}, image_labels: {}, source_revisions: {}, preflight_only: options[:preflight] }
sql = ->(db, query) do
  readonly = query.match?(/\A(?:SELECT|PRAGMA)/i)
  output = run("sqlite3", "-cmd", ".timeout 10000", *(readonly ? ["-readonly"] : []), "-json", db, query)
  output.strip.empty? ? [] : JSON.parse(output)
end
check_sample = ->(name, value) do
  raise "#{name}: unsuccessful requests #{value}" unless value.fetch("errors").zero? && value.fetch("invalid_responses", 0).zero? && value.fetch("statuses").keys == ["200"]
end
begin
  options[:rounds].times do |iteration|
    order = iteration.even? ? apps : apps.reverse
    order.each do |app|
      image = ENV.fetch("#{env_name.(app)}_IMAGE", { "rust" => "campfire-rust:app", "express-bun" => "once-campfire-express:bun" }.fetch(app, "once-campfire-#{app}:app"))
      source = File.join(workspace, app == "rust" ? "once-campfire-rust" : "once-campfire-express")
      metadata[:images][app] = run("docker", "image", "inspect", "-f", "{{.Id}}", image).strip
      metadata[:image_labels][app] = JSON.parse(run("docker", "image", "inspect", "-f", "{{json .Config.Labels}}", image))
      metadata[:source_revisions][app] = { head: run("git", "-C", source, "rev-parse", "HEAD").strip,
        dirty: !run("git", "-C", source, "status", "--porcelain").strip.empty? }
      data = File.join(work, "runtime", Process.pid.to_s, "#{app}-#{iteration + 1}")
      prepare_storage(options[:seed], data)
      FileUtils.mkdir_p(File.join(data, "logs"))
      db = File.join(data, "db/production.sqlite3")
      sql.call(db, "UPDATE push_subscriptions SET endpoint = 'https://127.0.0.1:9/push/' || id; UPDATE webhooks SET url = 'http://127.0.0.1:9/hook/' || id;")
      raise "invalid seed" unless sql.call(db, "SELECT COUNT(*) AS n FROM messages WHERE room_id=#{room}").first.fetch("n") > 50
      initial_max_id = sql.call(db, "SELECT MAX(id) AS id FROM messages").first.fetch("id")
      initial_messages = sql.call(db, "SELECT COUNT(*) AS n FROM messages WHERE room_id=#{write_room}").first.fetch("n")
      config = fixture_env.merge("WEB_CONCURRENCY" => "3", "JOB_CONCURRENCY" => "3", "RAILS_MAX_THREADS" => "5",
        "RAILS_LOG_LEVEL" => "warn", "HTTP_PORT" => options[:port].to_s, "TARGET_PORT" => (options[:port] + 1).to_s)
      config.merge!(JSON.parse(ENV.fetch("#{env_name.(app)}_BENCH_ENV", "{}")))
      metadata[:topology] ||= {}
      # The Rust port is one process: RAILS_MAX_THREADS sizes its reader pool, JOB_CONCURRENCY its job workers.
      metadata[:runtimes] ||= {}
      metadata[:runtimes][app] = runtimes.fetch(app)
      metadata[:topology][app] = app.start_with?("express") ? {http_workers: config.fetch("WEB_WORKERS", "auto (#{options[:cpus]} cpuset)"), cable: "native ws with cluster IPC", jobs: "leased auxiliary SQLite"} :
        {processes: 1, readers: config.fetch("RAILS_MAX_THREADS"), job_workers: config.fetch("JOB_CONCURRENCY"), cable: "native tokio", jobs: "in-process"}
      command = ["docker", "run", "-d", "--name", container, "--network", "host", "--cpuset-cpus", options[:cpus]]
      command.concat environment(config)
      command.concat mounts(File.join(data, "db") => "/rails/storage/db", File.join(data, "files") => "/rails/storage/files", File.join(data, "logs") => "/rails/storage/logs")
      command << image
      run(*command)
      client = BenchmarkHTTPClient.new(base)
      deadline = clock + 90
      until client.ready?
        raise "#{app} failed to start; inspect #{container} logs" if clock > deadline
        sleep 0.1
      end
      sleep 10 unless options[:preflight]
      cookie = lg.call("login", "--base", base, "--email", labels.fetch("emails.david"), "--password", labels.fetch("passwords.all")).fetch("cookie")
      scrape = lg.call("scrape", "--base", base, "--cookie", cookie, "--room", room.to_s)
      # Only Rails renders a CSRF token; both ports check Sec-Fetch-Site, which the load generator sends.
      csrf = scrape.fetch("csrf").to_s
      routes = { "room_show" => "/rooms/#{room}", "messages_page" => "/rooms/#{room}/messages?before=#{labels.fetch('messages.busy_060')}",
        "sidebar" => "/users/me/sidebar", "search" => "/searches?q=coffee", "avatar" => "/users/#{labels.fetch('avatar_tokens.jason')}/avatar",
        "static_css" => scrape.fetch("css"), "up" => "/up", "post_message" => nil }
      preflight = {}
      Net::HTTP.new("127.0.0.1", options[:port], nil).start do |http|
        routes.each do |name, path|
          next unless path
          response = http.get(path, "Cookie" => cookie, "Accept-Encoding" => "gzip")
          raise "#{app} #{name}: HTTP #{response.code}" unless response.code == "200"
          body = response.body
          body = Zlib::GzipReader.new(StringIO.new(body)).read if response["content-encoding"] == "gzip"
          raise "#{name}: empty body" if body.empty?
          raise "#{name}: unpopulated" if %w[room_show messages_page search].include?(name) && !body.match?(/data-message-id="\d+"/)
          raise "sidebar missing room" if name == "sidebar" && !(body.include?("shared_rooms") && body.include?(room.to_s))
          raise "invalid avatar" if name == "avatar" && !(response["content-type"].start_with?("image/") && body.bytesize > 100)
          raise "invalid CSS" if name == "static_css" && !(response["content-type"].start_with?("text/css") && body.include?("{"))
          raise "invalid health" if name == "up" && !body.include?("background-color: green")
          if %w[room_show messages_page search].include?(name)
            ids = body.scan(/data-message-id="(\d+)"/).flatten.map(&:to_i)
            expected_message_ids[name] ||= ids
            raise "#{app} #{name}: different result window from first implementation: #{ids.inspect} expected #{expected_message_ids[name].inspect}" unless ids == expected_message_ids[name]
          end
          preflight[name] = { message_ids: expected_message_ids[name], decoded_bytes: body.bytesize, wire_bytes: response.body.bytesize,
            body_sha256: Digest::SHA256.hexdigest(body), encoding: response["content-encoding"], content_type: response["content-type"] }
        end
      end
      row = { app: app, round: iteration + 1, preflight: preflight, http: [], cable: [], load_start: File.read("/proc/loadavg").strip }
      acknowledged_writes = 0
      unless options[:preflight]
        if options[:suites].split(",").include?("http")
          routes.each do |name, path|
            next unless options[:routes].split(",").include?(name)
            args = path ? ["--path", path] : ["--post-room", write_room.to_s, "--csrf", csrf]
            warmup = lg.call("http", "--base", base, "--cookie", cookie, *args, "--conc", "4", "--duration", "2")
            check_sample.call(name, warmup)
            acknowledged_writes += warmup.fetch("ok") unless path
            options[:concurrencies].split(",").each do |concurrency|
              value = lg.call("http", "--base", base, "--cookie", cookie, *args, "--conc", concurrency, "--duration", options[:duration].to_s)
              check_sample.call(name, value)
              acknowledged_writes += value.fetch("ok") unless path
              row[:http] << value.merge("route" => name)
              puts "#{app} round #{iteration + 1}: #{name} #{concurrency} clients #{value.fetch('rps')} req/s"
              STDOUT.flush
            end
          end
        end
        if options[:suites].split(",").include?("cable")
          options[:cable_clients].split(",").map { |value| Integer(value) }.each do |clients|
            value = lg.call("cable", "--base", base, "--cookie", cookie, "--room", room.to_s, "--csrf", csrf,
              "--streams", scrape.fetch("streams").join(","), "--clients", clients.to_s, "--tput-secs", options[:cable_tput_secs].to_s, "--posters", "4")
            write_json(File.join(options[:output], "#{app}-#{iteration + 1}-cable-#{clients}.json"), value)
            raise "incomplete Cable delivery" unless value.fetch("ready") == clients && value.fetch("failed").zero? && value.fetch("latency").fetch("complete") == value.fetch("latency").fetch("messages") && value.fetch("throughput").fetch("complete") == value.fetch("throughput").fetch("posted")
            row[:cable] << value
            puts "#{app} round #{iteration + 1}: Cable #{clients} connections, #{value.fetch("latency").fetch("complete")}/#{value.fetch("latency").fetch("messages")} paced messages fully delivered"
            STDOUT.flush
          end
        end
        if options[:suites].split(",").include?("upload")
          value = JSON.parse(run("taskset", "-c", options[:client_cpus], "ruby", ENV.fetch("UPLOAD_CHECK", File.join(repo, "tmp/validation/verify_upload.rb")), "--base", base, "--reps", "5"))
          raise "incomplete upload" unless value.fetch("runs").all? { |item| item["thumb_status"] == 200 && item.fetch("width") <= 1200 && item.fetch("height") <= 800 }
          row[:upload] = value
        end
      end
      actual_messages = sql.call(db, "SELECT COUNT(*) AS n FROM messages WHERE room_id=#{write_room}").first.fetch("n")
      raise "acknowledged HTTP writes missing" unless actual_messages - initial_messages >= acknowledged_writes
      raise "FTS entry missing" unless sql.call(db, "SELECT COUNT(*) AS n FROM messages WHERE id NOT IN (SELECT rowid FROM message_search_index)").first.fetch("n").zero?
      raise "rich text entry missing" unless sql.call(db, "SELECT COUNT(*) AS n FROM messages WHERE room_id=#{write_room} AND id>#{initial_max_id} AND id NOT IN (SELECT record_id FROM active_storage_attachments WHERE record_type='Message') AND id NOT IN (SELECT record_id FROM action_text_rich_texts WHERE record_type='Message' AND name='body')").first.fetch("n").zero?
      raise "fixture corrupt" unless sql.call(db, "PRAGMA integrity_check;").first.values == ["ok"]
      richtext_posts = sql.call(db, "SELECT COUNT(*) AS n FROM messages m JOIN action_text_rich_texts rt ON rt.record_type='Message' AND rt.record_id=m.id AND rt.name='body' WHERE m.room_id=#{write_room} AND m.id>#{initial_max_id} AND rt.body LIKE '%bench write %'").first.fetch("n")
      raise "acknowledged message body missing" if richtext_posts < acknowledged_writes
      row[:richtext_http_posts] = richtext_posts
      row[:persisted_writes] = actual_messages - initial_messages
      row[:load_end] = File.read("/proc/loadavg").strip
      results << row
      write_json(File.join(options[:output], "#{app}-#{iteration + 1}.json"), row)
      remove_container(container)
    end
  end
  raise "original seed changed" unless Digest::SHA256.file(File.join(options[:seed], "db/production.sqlite3")).hexdigest == original_seed_sha
  summary = apps.to_h do |app|
    rows = results.select { |row| row[:app] == app }
    values = %w[room_show messages_page sidebar search post_message].to_h do |name|
      samples = rows.filter_map { |row| row[:http].find { |item| item.fetch("route") == name && item.fetch("conc") == 16 }&.fetch("rps") }
      [name, samples.empty? ? nil : { median_rps: median(samples), runs: samples }]
    end
    [app, values]
  end
  write_json(File.join(options[:output], "summary.json"), metadata: metadata, results: summary)
  puts JSON.pretty_generate(summary)
ensure
  remove_container(container)
end
