# Campfire: cache i wydajność — Rails vs Express vs Rust

Raport z 2026-10-06. Porównuje, **gdzie** każda implementacja Campfire używa cache,
i zestawia to z benchmarkiem zmierzonym dziś na tej maszynie.

- Rails (oryginał): `reference/` (przypięty `659f957`, tylko do odczytu)
- Express (to repo): `src/`, `templates/`
- Rust: `../once-campfire-rust` (`crates/`)

Odwołania `plik:linia` są względne do katalogu głównego danej implementacji.

## 1. Podsumowanie

Rust jest na tej maszynie 6–45× szybszy od Expressa na ścieżkach HTTP (pokój: 19 237 vs 395 req/s,
wysłanie wiadomości: 4 462 vs 124 req/s), a w Action Cable dostarcza wiadomość do 100 klientów
w ~1,6 ms zamiast ~13 ms. Rails i Rust stosują cache na wielu warstwach: fragmenty HTML/JSON
kluczowane `updated_at`, ETag/304, cache odpowiedzi przed aplikacją (Thruster), kompresja.
Rust dokłada do tego cache skompresowanych kawałków stron i prepared statements.
Express ma tylko drobne memoizacje (klucze PBKDF2, manifest assetów) oraz ETag/`Cache-Control`
dla awatarów i assetów. Każde wyświetlenie pokoju renderuje i sanityzuje od nowa
40 wiadomości, a sam framework kosztuje niewiele. Do tego Express wstrzykuje do każdej strony
token CSRF zmieniany przy każdym żądaniu, więc nawet ETag nie może zwrócić 304 dla pełnych stron.

## 2. Wyniki benchmarku

### Zmierzone dziś (ta maszyna)

Mediana z 2 naprzemiennych rund, 16 klientów, gzip włączony. Dane pochodzą
z `tmp/bench/results/{reads,writes,cable}/summary.json`.

| Obciążenie HTTP (req/s) | Express | Rust | Rust / Express |
|---|---:|---:|---:|
| Strona pokoju (`room_show`) | 395 (398,6 / 390,5) | 19 237 (19 201,9 / 19 272,1) | ×48,8 |
| Strona wiadomości (`messages_page`) | 546 (544,6 / 547,0) | 21 326 (21 293,3 / 21 358,7) | ×39,1 |
| Sidebar | 3 059 (3 017,1 / 3 100,7) | 18 201 (18 196,1 / 18 205,5) | ×6,0 |
| Wyszukiwanie | 935 (935,7 / 935,1) | 18 693 (18 732,7 / 18 652,5) | ×20,0 |
| Wysłanie wiadomości (`post_message`, 15 s) | 124 (121,8 / 126,2) | 4 462 (4 488,2 / 4 436,3) | ×36,0 |

| Action Cable, 100 połączeń | Express | Rust |
|---|---:|---:|
| Dostarczone wiadomości (komplet / wysłane) | 30/30 w obu rundach | 30/30 w obu rundach |
| Mediana dostarczenia do wszystkich klientów (`latency.all_clients.p50_ms`) | 13,43 / 13,25 ms | 1,51 / 1,66 ms |
| Mediana POST (`latency.post.p50_ms`) | 8,26 / 8,58 ms | 1,28 / 1,33 ms |
| Błędy połączeń | 0 | 0 |

### Upstream (README.md, **inna maszyna**: AMD Ryzen AI MAX+ 395)

Te liczby służą tylko do orientacji. Nie należy ich mieszać z tabelą powyżej.

| req/s | Rails | Express | Rust |
|---|---:|---:|---:|
| Strona pokoju | 241 | 559 | 36 260 |
| Strona wiadomości | 413 | 777 | 40 872 |
| Sidebar | 552 | 4 125 | 34 672 |
| Wyszukiwanie | 435 | 1 294 | 33 299 |
| Wysłanie wiadomości | 273 | 256 | 6 896 |

Według README przy 100 połączeniach WebSocket mediana wynosiła 24 ms dla Rails i 14 ms dla Expressa.

### Metodologia

- Komendy: `npm run bench:image`, a potem `npm run bench`. To uruchamia po kolei
  `bench:reads` (4 s, trasy room_show, messages_page, sidebar, search),
  `bench:writes` (15 s, post_message) i `bench:cable` (100 klientów,
  `--cable-tput-secs 0`). Definicje są w `package.json:15-19`, orkiestracja w `bench/compare.rb`.
- Sprzęt: `nproc` = 16. Serwer dostaje 4 wątki sprzętowe (CPU 8–11), loadgen 4 inne (CPU 12–15),
  sieć `host`.
- Obrazy produkcyjne:
  - Express: `sha256:fd6e0a64…` (HEAD `361330a`, drzewo *dirty*, czyli zmiany w `bench/` i `package*.json`),
  - Rust: `sha256:c1bcca16…` (HEAD `ccece30`, czyste drzewo).
- Topologia:
  - Express: 3 workery HTTP w klastrze, WebSocket z IPC klastra, joby w osobnej bazie SQLite,
  - Rust: 1 proces, 5 readerów SQLite, 3 workery jobów, cable na tokio.
- Seed (`sha256:3e00b903…`) i loadgen (`sha256:b701a66d…`) pochodzą z `once-campfire-rust`
  (`parity/bin/seed`, `bench/loadgen`). Opis jest w `bench/README.md`.
- Ograniczenia: tylko 2 rundy, krótkie okna (4 s dla odczytów), a Rails nie był mierzony na tej
  maszynie. To benchmark syntetyczny, nie dowód zachowania produkcyjnego.

### Profil CPU Expressa (strona pokoju, lokalnie, 1 worker)

Profil wykonany w tej sesji. Surowe wyniki nie są zapisane w repo.

| Pozycja | Udział |
|---|---:|
| idle | 25% |
| `src/rendering.js` | 12,5% |
| nunjucks | 9,7% |
| `src/db.js` | 7,8% |
| GC | 4,4% |
| `sessionMiddleware` | 3,4% |
| sanitize-html | 2,5% |
| parse5 | 1,3% |
| express + router | ~1,2% |

Wniosek: sam framework kosztuje mało. Czas idzie na renderowanie, zapytania do bazy i brak
jakiegokolwiek cache treści.

## 3. Tabela warstw cache

Legenda: ✅ jest · 🟡 częściowo · ❌ brak

| Warstwa | Rails | Express | Rust |
|---|---|---|---|
| Fragment HTML wiadomości | ✅ `cache [message, "presentation-v3"]`, render kolekcji `cached: true` (read_multi). Preload tylko dla chybień. `app/views/messages/_message.html.erb:4`, `app/views/rooms/show.html.erb:17`, `app/models/message/pagination.rb:6-7` | ❌ każda wiadomość renderowana od nowa (`renderBody` → sanitize-html/parse5), `src/rendering.js:86-108`. Hooki `dot.Fragment`/`dot.MessagesHTML` w `templates/pages.html:38-39` nie są nigdzie ustawiane w `src/` | ✅ ten sam klucz z `/presentation-v3`, `crates/views/src/messages.rs:280-313` |
| Fragment boostu | ✅ `cache boost`, `app/views/messages/boosts/_boost.html.erb:1`, kolekcja `_boosts.html.erb:5` | ❌ | ✅ `crates/views/src/messages.rs:316-321` |
| Sidebar: pokoje direct | ✅ `cache membership`, `app/views/users/sidebars/rooms/_direct.html.erb:1`, `show.html.erb:23` | ❌ | ✅ `crates/views/src/users.rs:200-230` |
| JSON (jbuilder) | ✅ `json.cache!` w `messages/_message.json.jbuilder:1`, `messages/boosts/_boost.json.jbuilder:1`, `users/_user.json.jbuilder:1` | ❌ | ✅ klucz dodatkowo zawiera `base_url` (świadoma różnica), `crates/campfire/src/controllers/presenters.rs:80-84,363-386` |
| ETag / 304 dla HTML | ✅ framework: `Rack::ETag` + `Rack::ConditionalGet`. Strony są bajtowo stabilne, bo `load_defaults 8.2` (`config/application.rb:10`) ma CSRF oparte o `Sec-Fetch-Site`, bez tokenu per request | 🟡 domyślny słaby ETag Expressa przy `res.send`. Pełne strony dostają jednak per-request maskowany token CSRF (`src/app.js:59-60`, `src/rendering.js:286-293`), więc 304 praktycznie działa tylko dla fragmentów bez layoutu | ✅ SHA-256 ETag (`crates/kit/src/ctx.rs:663-700`), CSRF przez `Sec-Fetch-Site` (`ctx.rs:198-224`). ETag strony z fragmentów to hash skrótów części (`kit/src/deflater/splice.rs:11-13`) |
| `fresh_when` dla listy wiadomości | ✅ `app/controllers/messages_controller.rb:14` | ❌ brak, poza słabym ETagiem z `res.send` (`src/routes.js:467`) | ✅ `crates/campfire/src/controllers/messages.rs:35-44` |
| Awatary | ✅ `stale?(etag: @user)` + `public, max-age=30 min, swr=1 tydz.`, `app/controllers/users/avatars_controller.rb:9-10` | ✅ SHA-256 z `[id,name,updated_at,blob.id]`, `public, max-age=1800, swr=604800`, 304, `src/public.js:59-92` | ✅ `crates/campfire/src/controllers/users/avatars.rs:35` |
| Logo konta | ✅ `stale?` + `max-age=5 min`, `app/controllers/accounts/logos_controller.rb:8-9` | ❌ brak `Cache-Control`/ETag. Domyślne logo czytane `readFileSync` przy każdym żądaniu, `src/public.js:135-158` | ✅ `crates/campfire/src/controllers/accounts/logos.rs:24-30` |
| Kod QR | ✅ `expires_in 1.year, public`, `app/controllers/qr_code_controller.rb:8` | ❌ generowany przy każdym żądaniu, bez `Cache-Control`, `src/public.js:204-212` | ✅ (parytet; cache też przez front cache) |
| Assety statyczne | ✅ Propshaft: nazwy z digestem. Działa ostatnie `public_file_server.headers`, czyli `public, max-age=30 dni` (`config/environments/production.rb:75-77` nadpisuje `:20-31`) | ✅ `/assets` z `immutable`, `maxAge 1y` (`src/app.js:163-170`). Różni się od Rails (30 dni) | ✅ `public, max-age=2592000` + `If-Modified-Since`, `crates/assets/src/serve.rs:11,91-95` |
| Prekompresja assetów (.br/.gz) | 🟡 framework: `ActionDispatch::Static` serwuje `.br`/`.gz`, jeśli plik istnieje | ❌ `express.static` + `compression()` kompresuje przy każdym żądaniu | 🟡 serwuje `.br`/`.gz`, jeśli są osadzone (`crates/assets/src/serve.rs:79-88`). W praktyce dotyczy to tylko vendorowanego lexxy |
| Cache odpowiedzi przed aplikacją | ✅ Thruster (`Procfile:1` `bundle exec thrust`, gem `thruster` 0.1.23): cache w pamięci dla odpowiedzi `public` z `max-age` | ❌ | ✅ odpowiednik Thrustera, 64 MB (`CACHE_SIZE`), maks. 1 MB na wpis, `crates/kit/src/front/cache.rs:1-13`, `front/config.rs:80-81`. Usuwa `Set-Cookie` z cache'owalnych odpowiedzi (`front/handler.rs:102-104`) |
| Kompresja odpowiedzi dynamicznych | ✅ `use Rack::Deflater` (`config.ru:5`) + gzip/zstd Thrustera | ✅ `compression()` (`src/app.js:162`), ale bez reużycia: gzip całej strony za każdym razem | ✅ Rack::Deflater + cache gzipu całych ciał (`GZIPPED`, 16 MB, `crates/kit/src/deflater.rs:41,268`) + sklejanie prekompresowanych kawałków (`deflater/splice.rs`) + kompresja frontu (`front/compression.rs`) |
| Prepared statements | ✅ framework: pula statementów adaptera SQLite w ActiveRecord | ❌ `db().prepare(sql)` przy każdym `all/get/run`, `src/db.js:41-55` | ✅ `prepare_cached`, 256 na połączenie, `crates/db/src/database.rs:335,420`, `crates/db/src/sql.rs:17-53` |
| Pragmy SQLite | ✅ `timeout: 5000` (`config/database.yml:10`) + `DEFAULT_PRAGMAS` adaptera Rails 8 (WAL, `synchronous=normal`, `cache_size=2000`, `mmap_size`, `journal_size_limit`) | 🟡 tylko `busy_timeout=10000`, `foreign_keys=ON`, `journal_mode=WAL` (`src/db.js:24,35`). Brak `synchronous=normal` i `cache_size` | ✅ jak w Rails bez `mmap_size`, `crates/db/src/schema.rs:56-66`. Do tego 1 wątek zapisu + pula readerów (`database.rs:1-34`) |
| Kompilacja szablonów | ✅ ERB kompilowane raz w produkcji | 🟡 `FileSystemLoader` nunjucks cache'uje `pages.html`, ale `fragment()` przy każdym wywołaniu kompiluje wrapper przez `env.renderString` i wykonuje `import` (`src/rendering.js:220-225`). `stylesheets()`/`importmap()` czytają plik `readFileSync` przy każdym renderze (`src/rendering.js:14-17,180-181`). Manifest jest memoizowany (`:18-21`) | ✅ Askama: szablony kompilowane do Rusta w czasie budowania |
| Sesje / użytkownicy | ❌ brak cache aplikacyjnego (cookie store + zapytanie o sesję) | ❌ deszyfrowanie cookie i zapytanie przy każdym żądaniu (`src/app.js:29-60`). Memoizowane są tylko klucze PBKDF2: `Map`, maks. 64 wpisy (`src/rails.js:11,46-55`) | ❌ brak cache sesji/użytkowników |

## 4. Szczegóły per implementacja

### Rails

- **Magazyn**: `perform_caching = true` (`config/environments/production.rb:16`),
  `cache_store = :redis_cache_store` (`:72`). `config/redis.conf` nie ustawia `maxmemory`,
  więc cache rośnie bez limitu.
- **Klucze**: `views/<template>:<digest drzewa szablonów>/<table>/<id>-<updated_at>[/presentation-v3]`.
  Komentarz w `_message.html.erb:3` mówi, że zmiana linii `presentation-v3` zmienia digest
  i unieważnia zarówno fragment, jak i cache kolekcji.
- **Inwalidacja przez `touch`**:
  - `Boost belongs_to :message, touch: true` (`app/models/boost.rb:2`): boost unieważnia fragment wiadomości,
  - `Message belongs_to :room, touch: true` (`app/models/message.rb:4`),
  - `increment!/decrement!(:connections, touch: true)` (`app/models/membership/connectable.rb:45,49`):
    połączenie lub rozłączenie unieważnia fragment pokoju direct w sidebarze.
- **Kolekcje**: `cached: true` robi jedno `read_multi`. `Message::Pagination::Page`
  (`app/models/message/pagination.rb:8-25`) preloaduje asocjacje tylko dla chybień.
- **HTTP**:
  - `fresh_when @messages` dla stronicowania,
  - `stale?` + `expires_in` dla awatarów i logo,
  - `expires_in 1.year` dla QR,
  - Thruster cache'uje odpowiedzi `public` (domyślnie 64 MB, maks. 1 MB na wpis, według
    implementacji Thrustera odtworzonej w Ruście).

### Express

- **Brak cache treści.** `messageData` (`src/rendering.js:86-130`) dla każdej strony robi
  zapytania o body, załączniki i boosty, potem dla każdej wiadomości `renderBody`
  (`src/richtext.js:240`, sanitize-html + parse5). Brakujące nazwy autorów dociąga osobnym
  `get` per wiadomość (`src/rendering.js:126-128`).
- **Render strony**:
  - `render()` czyta konto i ustawienia z bazy (`src/rendering.js:226-240`),
  - renderuje nunjucks przez `renderString`,
  - dwoma `replace` na całym HTML-u wstawia token CSRF do `<head>` i do każdego `<form method="post">`
    (`:286-293`).

  Token jest maskowany losowo przy każdym żądaniu (`src/app.js:59-60`), więc body,
  a z nim słaby ETag, zmienia się za każdym razem.
- **Co jest**:
  - `Map` kluczy PBKDF2 (czyszczona przy 64 wpisach),
  - memo manifestu assetów,
  - ETag + `Cache-Control` dla awatarów,
  - `/assets` z `immutable` na 1 rok,
  - `compression()` dla wszystkiego.
- **Brak**: logo/QR bez nagłówków cache, brak cache statementów, brak `synchronous=normal`.

### Rust

1. **Fragment cache** (`crates/views/src/fragment_cache.rs`):
   - klucz `views/<template>:<digest>/<table>/<id>-<updated_at w µs>` (`:19-21,339-362`),
   - LRU liczony w bajtach: klucz + payload + 240 B narzutu (`:35-39`), domyślnie 32 MB,
     zmieniane przez `CAMPFIRE_FRAGMENT_CACHE_MB` (`crates/campfire/src/config.rs:24,136`),
   - po przekroczeniu limitu przycina do ¾, wpis większy niż ¼ limitu nie jest przechowywany (`:12-14`),
   - inwalidacja przez `touch` jak w Rails (`crates/db/src/models/boost.rs:72-87`).

   Obsługuje wiadomości, boosty, pokoje direct w sidebarze i JSON (message/boost/user).
2. **Splice** (`crates/kit/src/deflater/splice.rs`):
   - strona to sekwencja części (fragmenty ≥ 1 KB + tekst layoutu),
   - każda część jest kompresowana raz, ze słownikiem z części poprzedniej,
   - sklejanie odbywa się z łączeniem CRC-32,
   - magazyny `FRAGMENTS` (32 MB, do 4 kawałków na fragment), `TEXT_PIECES` (16 MB) i
     `TEXT_SHAS` (16 MB) (`:39-62,597-601`).

   ETag strony to hash skrótów części, bez hashowania całości. Wynik mieści się w 1% rozmiaru
   kompresji całej strony.
3. **`GZIPPED`** (`crates/kit/src/deflater.rs:35-41,223-269`): gzip całych powtarzalnych ciał
   (np. sidebar ~6 KB) kluczowany SHA-256 body, limit 16 MB, wpis maks. ¼ limitu.
4. **Front cache** (`crates/kit/src/front/cache.rs`):
   - odpowiednik Thrustera,
   - GET/HEAD z `public` i `max-age`/`s-max-age` > 0, bez `no-cache`,
   - wariant po `Vary`, nagłówek `X-Cache: hit/miss/bypass`,
   - limit 64 MB, maks. 1 MB na wpis, URI maks. 2048 znaków.
5. **HTTP**:
   - `Rack::ETag` (SHA-256, słaby) + `ConditionalGet` (`crates/kit/src/ctx.rs:636-700`),
   - `fresh_when` dla stronicowania wiadomości, awatarów i logo,
   - assety osadzone w binarce.
6. **DB**:
   - `prepare_cached` (256 na połączenie),
   - pragmy jak w adapterze Rails,
   - osobny wątek zapisu z kolejką oraz pula readerów (domyślnie 8, w benchmarku 5),
   - checkpointy WAL na osobnym wątku.
7. **Brak per-request CSRF** (`Sec-Fetch-Site`, `crates/kit/src/ctx.rs:198-224`). Bez tego
   punkty 2, 3 i 5 nie miałyby sensu, bo strony muszą być bajtowo stabilne.
8. **Brak** cache sesji i użytkowników.

## 5. Wnioski: co przenieść do Expressa (priorytety)

1. **Fragment cache wiadomości i boostów.** Klucz w stylu Rails
   (`messages/<id>-<updated_at>/presentation-v3` + wersja szablonu), LRU liczony w bajtach,
   inwalidacja przez `updated_at`. Wykorzystać istniejące hooki `dot.Fragment`/`dot.MessagesHTML`
   (`templates/pages.html:38-39`) i przy trafieniu pomijać `renderBody`. Najwięcej zyskają
   pokój, strona wiadomości i wyszukiwanie. Wymaga sprawdzenia, czy Express robi `touch`
   wiadomości przy boostach (inaczej fragmenty będą nieaktualne).
2. **CSRF przez `Sec-Fetch-Site`, jak Rails 8.2 `header_only`.** Alternatywa: niemaskowany token
   z sesji. Wtedy pełne strony są stabilne, a słaby ETag Expressa zaczyna zwracać 304.
   To zmiana kontraktu bezpieczeństwa: trzeba ją udokumentować w `plans/contracts.md`.
3. **Cache prepared statements.** `Map<sql, StatementSync>` w `src/db.js:41-55` (`node:sqlite`
   pozwala reużywać statementy) oraz pragmy `synchronous=normal` i `cache_size=2000` (parytet z Rails).
4. **Szablony.** Kompilować wrapper `fragment()` raz na nazwę (`env.getTemplate`/`Template`
   memoizowany) i memoizować `stylesheets()`/`importmap()` po starcie.
5. **`fresh_when` dla `/rooms/:id/messages`.** ETag z `id`+`max(updated_at)` liczony przed
   renderem, żeby 304 nie wymagało renderowania strony.
6. **Nagłówki dla logo i QR** (`stale?`/`expires_in` jak w Rails), opcjonalnie cache gzipu dla
   powtarzalnych ciał (sidebar).
7. **Front cache / Thruster** to opcja wdrożeniowa (reverse proxy z cache dla odpowiedzi
   `public`). Zysk dotyczy głównie awatarów, QR i assetów, nie stron pokoju.

Każdą z tych zmian trzeba zmierzyć ponownie (`npm run bench`). Same testy jednostkowe nie
uzasadniają twierdzeń o wydajności produkcyjnej.
