# EVREN Codex Bridge

EVREN Codex Bridge, OpenAI Codex CLI'yi EVREN'in OpenAI uyumlu Responses API'siyle kullanmak için geliştirilmiş bağımsız bir uyumluluk köprüsüdür. Yerel olarak çalışır, araçların yürütülmesini Codex'in denetiminde tutar ve model çıkarımı için varsayılan olarak `deepseek-v4.1-flash` modelini kullanır.

Bu belge EVREN Codex Bridge `v1.3.0` sürümünü açıklar. Uyumluluk hedefi OpenAI Codex CLI `0.156.1` (`rust-v0.156.1`) sürümüdür; bu ifade diğer sürümlerin çalışmadığı anlamına gelmez.

## Amaç

Codex CLI ile OpenAI uyumlu bir Responses uç noktası; araçları, konuşma devamlılığını ve akıl yürütme geçmişini farklı biçimlerde temsil edebilir. Bu proje, Codex'i değiştirmeden, EVREN entegrasyon testlerinde gözlemlenen bu uyumluluk farklarını giderir.

Köprü bilinçli olarak yerel ve dar kapsamlı tutulmuştur: Codex Responses isteklerini `127.0.0.1` üzerinde kabul eder, yalnızca desteklenen alanları dönüştürür, çıkarım isteklerini EVREN'e iletir ve Codex uyumlu yanıtlar döndürür.

## Mimari

```text
Codex CLI
    ↓
EVREN Codex Bridge (127.0.0.1)
    ↓
Native Responses compatibility
    ↓
EVREN / deepseek-v4.1-flash
```

Varsayılan aktarım yöntemi `native` seçeneğidir. Standart işlev araçları doğrudan standart işlev olarak aktarılır; Codex özel araçları ise `input` dizgesi içeren katı şemalı işlevler olarak sarmalanır. Konuşmanın devamı, temizlenmiş yerel oturum geçmişinden yeniden oluşturulur; akıl yürütme geçmişi filtrelenir. Metin tabanlı araç protokolü gerektiğinde açıkça seçilebilen bir geri dönüş seçeneğidir.

## Özellikler

- Yerel Responses aktarımı
- Codex işlev ve özel araç uyumluluğu
- Sunucu durumuna dayanmayan yerel devamlılık uyarlaması
- Codex izin verdiğinde doğrulanan native paralel araç çağrıları; metin tabanlı geri dönüşte güvenli serileştirme
- Geçmiş araç çıktılarının yeniden oynatılmasına karşı koruma
- Kanonik geçmişin yapısal olarak tekilleştirilmesi ve yerel çok turlu devamlılık
- `thread_id` tabanlı mantıksal oturum kimliği ve çakışan kimliklerde güvenli ret
- Codex'in kendi `compaction` / pencere geçişini izleyen, eski pencereyi ancak doğrulanmış replacement geçmişi geldiğinde bırakan aktif bağlam yönetimi
- Kümülatif oturum kullanımı ile aktif model bağlamını ayrı gösteren ölçümler
- Yinelenen belirlenimci hatalara ve gereksiz token tüketimine karşı devre kesici
- Geçerli ücretsiz ve pozitif `CR` fiyatlarını kabul eden, eksik/negatif/bozuk fiyat metadata'sında güvenli biçimde kapanan fiyatlandırma koruması
- EVREN yanıtındaki kesin kullanım verisini esas alan muhasebe
- Uzun süren `write_stdin` polling dizileri için güvenli sayaç, kesin token görünürlüğü, uyarı ve isteğe bağlı yerel hard cap
- Sistem talimatı, kanonik geçmiş, kabul edilmiş araç çıktısı geçmişi, araç kataloğu ve geçerli girdi için ayrı sayısal payload ölçümleri
- Çıktı bütçesi doygunluğu ve güvenilir Codex metadata sınıfları için güvenli tanı olayları
- Başlangıçta bir kez çalışan, başarısızlığı köprüyü etkilemeyen anonim GitHub sürüm denetimi
- İstek, oturum, gün ve araç çağrısı sınırları
- Oturum/istek/araç sınırında yalnızca ulaşılan limiti önerilen değere yükselten, başarısız isteği otomatik yinelemeyen `[R]` kurtarma akışı
- Yalnızca yerel makinede dinleyen sunucu
- Gizli bilgileri koruyan yapılandırılmış günlükleme
- Olay güdümlü canlı TTY gösterge paneli
- Gösterge panelinden `F1` ile açılan Türkçe Yardım / Hızlı Başlangıç ve yapılandırma akışı
- Metin tabanlı geri dönüş aktarımı

## Gereksinimler

- Node.js 20 veya daha yeni bir sürüm
- OpenAI Codex CLI (bu sürüm `0.156.1` ile test edilmiştir)
- EVREN API anahtarı
- Birlikte sunulan kurulum yardımcıları için PowerShell

## Kurulum

```powershell
git clone https://github.com/berkaycari/evren-codex-proxy.git
cd evren-codex-proxy
npm.cmd install
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
```

Depo bir npm paketi olarak yayımlanmamıştır; `private: true` bilinçli bir tercihtir.

## Yapılandırma

`.env.example`, desteklenen ortam değişkenlerini belgeler; ancak köprü gizli bilgi içeren bir dosya gerektirmez. API anahtarını yalnızca geçerli işlem ortamında ayarlayın:

```powershell
$env:EVREN_API_KEY = (Get-Clipboard -Raw).Trim()
```

Gerçek bir `.env` dosyasını veya API anahtarını hiçbir zaman Git'e işlemeyin. `.gitignore`, yalnızca yer tutucu değerler içeren `.env.example` dışındaki `.env*` dosyalarını, çalışma zamanı günlüklerini ve kullanım verilerini dışarıda bırakır.

Gizli olmayan sayısal sınırlar, `config/defaults.json` içindeki alanlara karşılık gelen büyük harfli ortam değişkenleriyle geçersiz kılınabilir. Sunucu adresi, EVREN temel URL'si ve model bilinçli olarak ortam değişkenleriyle değiştirilemez. Araç aktarım yöntemi yalnızca `native` veya `textual` değerini kabul eder.

İsteğe bağlı ve gizli bilgi içermeyen yerel ayarlar `config/local.json` dosyasına yazılabilir. Bu dosya git tarafından yok sayılır ve bulunması zorunlu değildir. Öncelik sırası şöyledir:

```text
ortam değişkeni > config/local.json > config/defaults.json
```

`config/local.json`; `maxSessionTokens`, `maxDailyTokens`, `maxRequestsPerSession`, `maxToolCallsPerSession`, `maxEstimatedInputTokensPerCall`, `maxOutputTokensPerCall`, `sessionTtlMinutes`, `toolOutputMaxChars`, `toolPollWarningThreshold`, `maxConsecutiveToolPollInferences`, `pricingRefreshMinutes`, `requestTimeoutMs`, `maxSessionCredits`, `maxDailyCredits`, `minCreditsRemaining` ve `updateCheckEnabled` alanlarını destekler. Token/istek/araç alanları pozitif tam sayıdır; `maxConsecutiveToolPollInferences` negatif olmayan tam sayıdır. Üç kredi alanı sonlu, negatif olmayan ondalık değer kabul eder ve `0` o denetimi kapatır. Ortam karşılıkları `MAX_SESSION_CREDITS`, `MAX_DAILY_CREDITS` ve `MIN_CREDITS_REMAINING` adlarıdır. `updateCheckEnabled` yalnızca boolean kabul eder. Bilinmeyen, geçersiz veya gizli bilgi izlenimi veren bir alan bulunduğunda köprü açık bir hatayla başlatılmaz. Bu dosyaya gizli bilgi yazmayın; `EVREN_API_KEY` ayrı tutulur ve yalnızca işlem ortamından okunur.

Windows üzerinde ayarları etkileşimli olarak düzenlemek için isteğe bağlı yardımcıyı çalıştırın:

```powershell
.\scripts\configure-bridge.ps1
```

Betik üç preset sunar. Seçimi `↑` / `↓` ile yapın, `Enter` ile onaylayın veya `Esc` ile iptal edin:

- `Standard`: ana güvenlik limitlerini `maxSessionTokens=1200000`, `maxDailyTokens=10000000`, `maxRequestsPerSession=60`, `maxToolCallsPerSession=80` ve `maxOutputTokensPerCall=4096` değerlerine getirir; diğer desteklenen yerel ayarları korur.
- `Coding`: uzun coding-agent işleri için ana güvenlik limitlerini `maxSessionTokens=3000000`, `maxDailyTokens=10000000`, `maxRequestsPerSession=120`, `maxToolCallsPerSession=140` ve `maxOutputTokensPerCall=4096` değerlerine getirir; diğer desteklenen yerel ayarları korur.
- `Custom`: izin verilen alanların mevcut etkileşimli düzenleme akışını açar.

`Standard` ve `Coding`, mevcut kredi ayarlarını değiştirmez. EVREN'in katalog fiyatları için birim/çarpan sözleşmesi bulunmadığından `maxSessionCredits` ve `maxDailyCredits` pozitifken köprü kesin harcama hesabı uydurmaz; çıkarımı `credit_spend_accounting_unavailable` ile engeller. `minCreditsRemaining`, yalnızca geçerli `X-Evren-Credits-Remaining` değeri daha önce alınmışsa sonraki çıkarımları `remaining <= minimum` koşulunda yerel olarak engeller. İlk istekten önce sağlayıcı bakiyesi bilinmiyorsa katı bir preflight garantisi yoktur. Bozuk kredi başlığı sıfır kabul edilmez.

Depo varsayılanları normal/orta büyüklükte işler için `maxSessionTokens=1200000`, `maxRequestsPerSession=60`, `maxToolCallsPerSession=80`, `maxDailyTokens=10000000` ve `maxOutputTokensPerCall=4096` değerlerini kullanır. Preset'ler model yeteneğini veya model context window'unu değiştirmez; yalnızca yerel güvenlik sınırlarını değiştirir. `Enter` tuşu geçerli değeri korur. Betik yalnızca `config/local.json` dosyasını atomik olarak yazar; köprünün normal başlangıcı bu betiği çalıştırmaz.

Polling ayarlarının varsayılanları `toolPollWarningThreshold=3` ve `maxConsecutiveToolPollInferences=0` değerleridir. Köprü yalnızca tam adı `write_stdin` olan ve Codex şemasındaki `session_id` alanını taşıyan çağrıları poll olarak tanır. Süreç kimliği yalnızca SHA-256 özetiyle oturum belleğinde tutulur; komut, araç argümanları, süreç kimliği ve araç çıktısı olaylara yazılmaz. Varsayılan davranış uyarı ve ölçümdür. İsteğe bağlı pozitif hard cap etkinleşirse bir sonraki poll devamı EVREN çağrısından önce kararlı bir yerel `400 tool_poll_limit_reached` hatasıyla durur; yeni çıkarım, kullanım veya araç çağrısı oluşturmaz. Bu seçenek uzun süren meşru işlemi de durdurabileceği için varsayılan olarak kapalıdır.

`updateCheckEnabled=true` varsayılanıyla köprü, süreç başına en fazla bir kez GitHub'ın herkese açık `latest release` metadata uç noktasına kısa zaman aşımıyla anonim `GET` isteği yapar. Bu istek kimlik doğrulama, `EVREN_API_KEY`, istem, oturum, kullanıcı veya araç verisi içermez. Güncelleme otomatik uygulanmaz; `git pull`, kurulum veya build çalıştırılmaz. Çevrimdışı durum, zaman aşımı, rate limit ya da bozuk yanıt başlangıcı ve çıkarımı engellemez. Tam opt-out için `UPDATE_CHECK_ENABLED=false` kullanın veya `config/local.json` içinde `"updateCheckEnabled": false` ayarlayın.

## Kullanım

İlk terminalde köprüyü derleyip başlatın:

```powershell
cd evren-codex-proxy
.\scripts\start-proxy.ps1
```

Yalıtılmış Codex sağlayıcı profilini bir kez yapılandırın:

```powershell
.\scripts\configure-codex-evren-proxy.ps1
```

Yardımcı betik değişikliklerin ön izlemesini gösterir, onay ister ve zaman damgalı bir yedek oluşturur. Yalnızca EVREN sağlayıcı tablosunu ve ayrı EVREN profilini yönetir; ilgisiz Codex ayarlarını değiştirmez.

Yapılandırılan sağlayıcı URL'si `http://127.0.0.1:8787/v1` olmalıdır.

Ardından Codex'i üzerinde çalışmak istediğiniz depodan başlatın:

```powershell
cd <project-directory>
codex --profile evren
```

### Etkileşimli terminal yardımı

Köprü terminalini açık bırakın. Canlı TTY gösterge panelinde yalnızca `F1`, Türkçe Yardım / Hızlı Başlangıç ekranını açar. İkinci bir terminal açın, `cd <project-directory>` ile Codex'in çalışacağı projeye geçin, `codex --profile evren` komutunu çalıştırın ve istemlerinizi Codex terminaline yazın; köprü terminali durum, kullanım, güvenlik, yapılandırma ve tanılama içindir.

Yardım içindeki `C`, yapılandırmayı açar. Preseti `↑` / `↓` ile seçip `Enter` ile onaylayın; `Standard` ve `Coding` özeti yine `↑` / `↓` ile seçilen `Uygula` / `Vazgeç` adımıyla kesinleşir. İşlem uygulandığında, iptal edildiğinde veya güvenli biçimde başarısız olduğunda terminal otomatik olarak dashboard'a döner. Normal/hafif işler için `Standard`, daha büyük coding-agent işleri için `Coding`, tüm desteklenen gizli olmayan alanları bilinçli biçimde düzenlemek için `Custom` kullanın. `Coding`, model yeteneğini veya varsayılan `maxOutputTokensPerCall=4096` değerini artırmaz.

`MAX_SESSION_TOKENS`, `MAX_REQUESTS_PER_SESSION` veya `MAX_TOOL_CALLS_PER_SESSION` sınırına yerel olarak ulaşıldığında dashboard `LIMIT REACHED` görünümüne geçer. `[R]` yalnızca ulaşılan sınırı önerilen değere yükseltir; `[F1 → C]` özel yapılandırmayı açar. Ortam değişkeni etkin değeri yönetiyorsa `[R]` başarı taklidi yapmaz ve ilgili değişkeni bildirir. Başarısız Codex isteği açık tutulmaz veya otomatik yeniden gönderilmez: ayarı değiştirdikten sonra Codex terminaline dönüp aynı göreve açıkça devam edin.

Köprü şu uç noktaları sunar:

- `GET /health` — güvenli fiyatlandırma, bağlantı ve kullanım özeti
- `GET /v1/models` — Codex uyumlu model kataloğu
- `POST /v1/responses` — JSON ve SSE Responses uyarlayıcısı

## Gösterge paneli

![EVREN Codex Bridge v1.2.0 hesap makinesi coding-agent kabul testi](docs/evren-v1.2-calculator-acceptance.png)

EVREN Codex Bridge `v1.2.0` ile gerçekleştirilen gerçek bir coding-agent kabul testinden birleşik görüntü. Görsel; canlı köprü dashboard'unu, Codex agent çıktısını ve tarayıcıda çalışan Türkçe hesap makinesi arayüzünü aynı karede gösterir. Codex, `deepseek-v4.1-flash` üzerinden Vite + vanilla JavaScript projesini oluşturdu; temel hesaplama senaryolarını doğruladı ve üretim build'ini başarıyla tamamladı. Bu v1.2 çalışması ana Codex oturumunda `40` istek, `39` araç çağrısı ve `1.006.703` kesin oturum token'ı ile tamamlandı.

### v1.1 → v1.2 hesap makinesi gözlemi

v1.1 ve v1.2 kabul çalışmaları aynı uygulama sınıfını kullansa da istemleri ve çalışma koşulları birebir aynı değildir. Bu nedenle aşağıdaki değerler kontrollü bir performans benchmarkı veya nedensel bir verimlilik iddiası olarak değil, iki gerçek coding-agent çalışmasının gözlemsel karşılaştırması olarak okunmalıdır.

| Kabul çalışması | Oturum token'ı | İstek | Araç çağrısı |
| --- | ---: | ---: | ---: |
| v1.1 hesap makinesi | 1.118.374 | 51 | 48 |
| v1.2 hesap makinesi | 1.006.703 | 40 | 39 |
| Gözlenen fark | -111.671 (-%10,0) | -11 (-%21,6) | -9 (-%18,8) |

v1.2 çalışmasında daha düşük sayaçlar gözlenmiştir; ancak istem farkları, model davranışındaki değişkenlik ve araç yürütme ayrıntıları nedeniyle bu fark tek başına köprü sürümünün performans artışı olarak yorumlanmamalıdır.

### Snake coding-agent kabul testi

![EVREN Codex Bridge v1.2.0 Snake coding-agent kabul testi](docs/evren-v1.2-snake-acceptance.png)

v1.2 sürüm kabulünün ikinci canlı coding-agent senaryosunda Codex, `deepseek-v4.1-flash` üzerinden Vite + vanilla JavaScript ile responsive ve Türkçe bir Snake oyunu oluşturdu. Oyun; `20×20` grid, klasik hareket ve büyüme, rastgele yem, duvar/kendi gövdesi çarpışması, ters yöne anlık dönüş koruması, skor ve `localStorage` tabanlı en iyi skor, hız artışı, klavye kontrolleri ve mobil yön düğmeleri içerir. Oyun mantığı tarayıcı DOM'undan ayrıştırılarak hafif Node testleriyle doğrulandı; kurulum, test ve üretim build adımlarının tamamı başarıyla geçti.

Bu daha ağır coding-agent çalışması aynı Codex oturumunda `70` istek, `66` araç çağrısı ve `2.578.972` kesin oturum token'ı ile tamamlandı; final yanıtta son kesin kullanım `52.412` girdi ve `812` çıktı token'ı olarak raporlandı. Test sırasında daha düşük bir geçici oturum tavanına güvenli biçimde ulaşıldı; yerel Custom güvenlik sınırı yükseltildikten sonra aynı proje durumu korunarak çalışma tamamlandı. Bu gözlem, oturum tavanının model context window'u değil, köprünün kümülatif yerel güvenlik sınırı olduğunu da pratikte doğrular.

#### v1.3.0 aynı-prompt Snake çalışması

![EVREN Codex Bridge v1.3.0 Snake coding-agent kabul testi](docs/evren-v1.3-snake-acceptance.png)

v1.3.0 release-candidate üzerinde aynı Snake görev istemi `deepseek-v4.1-flash` ile yeniden çalıştırıldı. Codex responsive Türkçe Snake uygulamasını tamamladı; `22/22` uygulama testi geçti, production build başarıyla alındı ve uygulamanın tarayıcıda açıldığı ayrıca doğrulandı. Bridge oturumu `34` istek, `34` inference, `33` araç çağrısı ve `925.164` kesin oturum token'ı ile tamamlandı. Son EVREN çağrısı `33.533` girdi ve `1.106` çıktı token'ı kullandı; dashboard yaklaşık `40K` aktif bağlam gösterdi ve bu çalışmada compaction tetiklenmedi.

| Snake çalışması | Oturum token'ı | İstek | Inference | Araç çağrısı |
| --- | ---: | ---: | ---: | ---: |
| v1.2.0 | 2.578.972 | 70 | 70 | 66 |
| v1.3.0 | 925.164 | 34 | 34 | 33 |
| Gözlenen fark | -1.653.808 (-%64,1) | -36 (-%51,4) | -36 (-%51,4) | -33 (-%50,0) |

İstem aynı olsa da bu iki canlı agent koşusu tamamen deterministik bir laboratuvar benchmarkı değildir: model/araç kararları değişebilir ve v1.2 çalışmasında geçici `1.800.000` oturum sınırına ulaşılıp daha sonra limit yükseltilmişti. Bu nedenle tablo, v1.3'ün tek başına `%64,1` performans artışı sağladığı şeklinde yorumlanmamalıdır. Buna rağmen aynı görev istemindeki gözlenen kümülatif kullanım, istek ve araç çağrısı farkı release acceptance kaydı olarak saklanır. Bu v1.3 koşusunda compaction sayısının `0` olması nedeniyle compaction sonrası aktif-history replacement davranışı ayrıca manuel kabul senaryosunda doğrulanmalıdır.

Köprü, TTY ortamında yalnızca gerçek köprü durumunu gösteren alternatif ekranlı bir gösterge paneli açar. Panel; bağlantıyı, seçili aktarım yöntemini, modeli, `FREE`/`PAID` fiyat durumunu, kredi başlıklarını, istek/çıkarım/araç/token sayaçlarını, etkin poll dizisini, kümülatif oturum token'ını, yaklaşık aktif bağlamı, kabul edilmiş compaction sayısını, geçerli `FLOW` aşamasını ve son kesin girdi/çıktı kullanımını gösterir. Kümülatif oturum token'ı yerel güvenlik muhasebesidir; model context window'u değildir. `FLOW`, gerçek olaylara göre `READY → CODEX → EVREN → TOOL → RESULT → FINAL` sırasıyla ilerler; hatalar `ERROR` olarak gösterilir. Periyodik fiyat yenilemesi etkin bir `TOOL`, `CODEX`, `EVREN` veya limit-kurtarma durumunu ezmez. `Last` değeri EVREN yanıtındaki kesin `input_tokens` ve `output_tokens` alanlarından gelir. `≈` işaretli aktif bağlam değeri UTF-8 byte tabanlı yerel tahmindir.

`EVREN_USAGE` olayları toplam payload boyutuna ek olarak talimat, kanonik geçmiş, kabul edilmiş araç çıktısı geçmişi, geçerli girdi ve araç kataloğu byte değerlerini ayrı verir. Oturum toplamları; toplam upstream payload, tekrar oynatılan kanonik geçmiş, geçerli girdi, araç kataloğu, araç çıktısı geçmişi ve tepe/aktif bağlam byte değerlerini saklar. Replay payı kesin token israfı değil, `history bytes / total measured payload bytes` tanısıdır. Native aktarımda `tool_choice=none` katalog göndermez; adlandırılmış seçim yalnızca tam eşleşen aracı gönderir; `auto` ve `required` tam kataloğu korur. Tahmine dayalı araç seçimi yapılmaz.

Codex `request_kind=compaction` isteği tek başına geçmişi silmez. Başarılı compaction sonrasında aynı `thread_id` için doğrulanmış yeni `window_id`, `window_number` veya `context_window_id` ve canonical replacement girdi geldiğinde aktif bağlam deterministik olarak yeniden kurulur; eski pencere sonraki EVREN payload'larından çıkarılır. Kümülatif kullanım ve günlük muhasebe sıfırlanmaz. `turn` foreground; `prewarm`, `compaction` ve `memory` internal; bilinmeyen değerler `unclassified` olarak kalır.

EVREN'in kesin `output_tokens` değeri yapılandırılmış `maxOutputTokensPerCall` değerine eşit veya ondan büyükse `OUTPUT_BUDGET_SATURATED` uyarısı oluşur. Bu yalnızca doygunluk kanıtıdır; yanıt otomatik olarak geçersiz ya da kesin kesilmiş sayılmaz. Aynı yanıtta protokol dönüşümü başarısız olursa güvenli hata mesajı bu olası ilişkiyi belirtir. Varsayılan çıktı bütçesi `4096` olarak kalır.

Fiyat satırı, model kataloğundaki `prompt_token_price`, `completion_token_price`, `currency` ve varsa `free_until` değerlerini gösterir. Her iki fiyat `0 CR` ise `FREE`, geçerli fiyatlardan biri pozitifse `PAID` gösterilir. EVREN ayrıca bir fiyat birimi/çarpanı tanımlamadığı için köprü token fiyatlarından harcama uydurmaz. Başarılı çıkarım yanıtlarında alınan geçerli `X-Evren-Credits-Held` ve `X-Evren-Credits-Remaining` değerleri son güvenilir kredi durumu olarak gösterilir; eksik veya geçersiz değerlerin yerinde `—` görünür. Bu başlıklardan istek maliyeti türetilmez.

Animasyon zamanlayıcısı, benzetilmiş trafik veya yapay token etkinliği yoktur. Görüntü yalnızca köprü durumu değiştiğinde ya da terminal yeniden boyutlandırıldığında yenilenir. TTY dışındaki normal düz günlük çıktısını kullanmak için `NO_DASHBOARD=1` ayarlayın.

## Gösterim

25–30 saniyelik bir okuma/yazma gösterimi için köprüyü başlatın ve bu depo içinde EVREN profiliyle Codex'i çalıştırın. Aşağıdaki istemi aynen yapıştırın. İstem iki gerçek terminal aracı çağrısı yaptırır; `.gitkeep` dışındaki `data/*` dosyaları göz ardı edildiği için izlenen bir değişiklik bırakmaz.

```text
Run a quick read/write smoke test only inside the current repository.

Use exactly 2 terminal tool calls.

Tool call 1:
- Read package.json from disk and obtain the actual package name.
- Create data/.evren-demo-smoke.txt containing exactly:
  EVREN_NATIVE_OK
- Report in the tool output whether the write operation succeeded.

Tool call 2:
- Read data/.evren-demo-smoke.txt back from disk.
- Verify whether the contents exactly equal:
  EVREN_NATIVE_OK
- Delete only data/.evren-demo-smoke.txt.
- Confirm whether the file no longer exists.
- Report in the tool output:
  - the actual package name
  - whether the write succeeded
  - whether the read-back exact-match verification succeeded
  - whether cleanup succeeded

Do not touch any other file.
Do not install anything.
Do not commit or push.
Do not make network requests.

After the second tool result, reply using only facts actually verified from the tool outputs.

Use this exact format:

package=<actual package name read from package.json>
write=<pass or fail based on the tool result>
read=<pass or fail based on the exact read-back verification>
cleanup=<pass or fail based on the file deletion verification>
tools=2

Do not assume or hard-code any success value.
Do not report pass unless the tool output proves it.
```

## Güvenlik ve sınırlamalar

- Sunucu yalnızca `127.0.0.1` adresine bağlanır.
- Başlangıçta ve düzenli aralıklarla yapılan fiyat kontrolleri sıfır veya pozitif, sonlu ve negatif olmayan `CR` fiyatlarını kabul eder. Eksik, negatif, bozuk veya başka para birimli metadata çıkarımı engeller.
- Kesin sağlayıcı harcama semantiği olmadığı için oturum/gün kredi bütçeleri pozitifken çıkarım güvenli biçimde engellenir; bu alanlar sessizce yok sayılmaz. Bilinen güvenilir kalan kredi için minimum taban denetimi uygulanabilir.
- API anahtarları ve bilinen yetkilendirme alanları yapılandırılmış günlüklerde maskelenir.
- İstemler, araç bağımsız değişkenleri, komutlar, ham araç çıktıları, akıl yürütme içeriği ve bilinmeyen olay üst verileri gösterge paneli etkinlik akışına alınmaz.
- Eksik veya tutarsız kesin kullanım bilgisi hiçbir zaman sıfır sayılmaz; yeniden başlatılana kadar başka çıkarım yapılması engellenir.
- Oturum, gün, istek, tahmini girdi, çıktı, araç çağrısı ve araç çıktısı sınırları uygulanmaya devam eder.
- Çalışma zamanı kullanım dosyaları, göz ardı edilen `data/` dizinine atomik olarak yazılır; günlükler ise göz ardı edilen `logs/` dizininde tutulur.

Köprü kendi başına kabuk komutu yürütmez, proje dosyalarını okumaz veya araç çalıştırmaz. Araçların yürütülmesi Codex'in denetimindedir.

## Uyumluluk notları

Geliştirme dönemindeki canlı bütünleştirme testlerinde şunlar gözlemlenmiştir:

- EVREN'in yerel standart işlev çağrıları başarıyla tamamlandı.
- Üst EVREN hizmetinde `previous_response_id` ile devamlılık desteklenmediği için köprü bu alana dayanmaz; konuşmayı yerel kanonik geçmişle sürdürür.
- EVREN, `parallel_tool_calls=false` gönderildiğinde bile birden fazla yerel işlev çağrısı döndürebilir. Bu durumda köprü ilk çağrıyı güvenli biçimde serileştirir. Codex `parallel_tool_calls=true` gönderdiğinde bütün geçerli native çağrılar doğrulanır, tek batch olarak Codex'e döner ve aynı oturumdaki birlikte ya da kısmi çıktılar replay/collision kurallarıyla işlenir. Textual fallback serileştirilmiş kalır.
- Aynı belirlenimci başarısız isteğin yinelenmesi, gereksiz üst hizmet denemelerini ve token tüketimini sınırlayan yerel bir devre kesiciyle durdurulur.
- Geçmişte `reasoning_text` yeniden oynatıldığında bir uyumluluk sorunu oluşmuştur.
- Yerel özel araç tanımlarının gidiş-dönüş aktarımı tutarlı biçimde güvenilir değildir.
- Bu nedenle köprü, Codex özel araçlarını standart bir işlev sarmalayıcısına dönüştürür ve akıl yürütme geçmişini filtreler.

Bunlar, bu proje için kullanılan EVREN/Codex sürümleri ve test dönemiyle ilgili gözlemlerdir; EVREN platformunun kalıcı davranışına ilişkin garanti değildir. Taraflardan biri değiştiğinde bunları yeniden doğrulayın.

## Metin tabanlı geri dönüş

Varsayılan aktarım yöntemi `native` seçeneğidir. Bir oturumda önceki metin tabanlı araç protokolünü kullanmak için:

```powershell
$env:EVREN_TOOL_TRANSPORT = 'textual'
.\scripts\start-proxy.ps1
```

`textual` modu, mevcut katalog ve istem protokolüyle tek düzeltme denemesini korur. Fiyatlandırma, kullanım, oturum veya güvenlik sınırlarını değiştirmez.

## Kontrollü benchmark ve proje yönergeleri

Sabit hesap makinesi ve Snake senaryoları ile kayıt şablonu [`benchmarks/README.md`](benchmarks/README.md) altında bulunur. Sonuçlar yalnızca aynı istem, temiz eşdeğer proje dizini, aynı Codex/model/transport/preset ve eşdeğer paket-cache/ağ koşullarıyla karşılaştırılabilir. Otomatik testler canlı ve yüksek token'lı benchmark çalıştırmaz. v1.3 için verimlilik kanıtı, bir Codex pencere replacement'ından sonra eski pre-compaction geçmişinin sonraki EVREN payload'larında bulunmamasıdır; ölçülmemiş bir yüzde iddiası yapılmaz.

Köprü kullanıcı deposunu taramaz, indekslemez veya kalıcı bir proje bilgi tabanı oluşturmaz. Codex'in kendisi kısa bir `AGENTS.md` dosyasından yararlanabilir. Bu dosyada proje amacı, kısa mimari harita, önemli dizinler, test/build komutları, değişmezler ve taranmaması gereken generated/vendor dizinleri bulunabilir. Devasa bir `AGENTS.md` kalıcı talimat yükünü ve bağlam kullanımını artırır; yalnızca gerçekten gerekli, güncel bilgiyi tutun. Köprü kullanıcı projelerinde bu dosyayı zorla oluşturmaz.

## Test ve doğrulama

Otomatik kontroller:

```powershell
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
git diff --check
```

Elle sürüm kabulü ayrıca `native` ve `textual` aktarım yöntemlerini, canlı EVREN bağlantısını, normal ve dar terminal genişliklerinde gösterge panelinin `FLOW` akışını ve renklerini, iki araçlı gösterimi, `Ctrl+C` sonrasında terminalin önceki durumuna dönmesini, TTY dışı çıktıyı ve `NO_DASHBOARD=1` davranışını doğrulamalıdır. v1.3 senaryo adımları [`docs/v1.3-manual-acceptance.md`](docs/v1.3-manual-acceptance.md) dosyasındadır.

Anahtar önceden ayarlanmışsa araç içermeyen isteğe bağlı küçük bir canlı çıkarım testi çalıştırılabilir:

```powershell
npm.cmd run smoke:evren
```

## Sorun giderme

- `EVREN_API_KEY is required`: anahtarı geçerli PowerShell işlemi içinde ayarlayın.
- `/health` çıktısı `blocked` bildiriyor: güvenli fiyatlandırma nedenini ve köprü olay günlüğünü inceleyin.
- `usage_accounting_uncertain`: EVREN geçerli bir kesin kullanım bilgisi döndürmedi; güvenli biçimde yeniden başlatın ve durum tekrarlanırsa araştırın.
- `unknown_previous_response_id`: yerel oturumun süresi doldu veya köprü yeniden başlatıldı; yeni bir Codex oturumu başlatın.
- `usage_limit_exceeded`: hızlı kurtarmaya uygun oturum/istek/araç sınırında Bridge terminalindeki `[R]` seçeneğini kullanın veya `F1 → C` ile yalnızca gerekli ayarı değiştirin; sonra Codex terminaline dönüp göreve devam edin. Günlük/tahmini girdi/poll sınırları körlemesine yükseltilmez.
- `credit_spend_accounting_unavailable`: EVREN kesin kredi harcama birimini sağlamadığı için `maxSessionCredits`/`maxDailyCredits` pozitif değerleri uygulanamaz; güvenli biçimde `0` bırakın veya sağlayıcı sözleşmesini doğrulayın.
- `minimum_credits_remaining_reached`: son güvenilir kalan kredi yapılandırılmış tabana eşit veya altındadır; otomatik yükseltme yapılmaz.
- Model kataloğu hatası: sağlayıcı temel URL'sinin tam olarak `http://127.0.0.1:8787/v1` olduğunu doğrulayın.
- Windows üzerinde `npm.cmd install` sertifika/CA hatası veriyor veya TLS aşamasında takılı görünüyorsa proje terminalinde aşağıdakini deneyebilirsiniz; bu ayar tüm npm sorunlarını çözeceğine dair bir garanti değildir ve köprü çalışma zamanına otomatik eklenmez:

```powershell
$env:NODE_OPTIONS="--use-system-ca"
npm.cmd install
```

- Uzun süren paket yöneticisi komutları Codex'in çalışan işlemi `write_stdin` ile tekrar tekrar yoklamasına ve her karar için ek model token'ı tüketmesine neden olabilir. Dashboard'daki etkin `Polls` sayacını ve poll token toplamını izleyin; gerekirse işlemi veya Codex oturumunu bilinçli biçimde yönetin.

## Lisans

[MIT Lisansı](LICENSE) kapsamında lisanslanmıştır.
