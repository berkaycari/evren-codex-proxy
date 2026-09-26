# EVREN Codex Bridge controlled benchmarks

Bu dizin canlı benchmark çalıştırmaz. Amaç, v1.2/v1.3 veya sonraki sürümlerin yalnızca kontrollü koşullarda karşılaştırılmasıdır.

Her çalışma için kaydedilmesi zorunlu koşullar:

- Bridge sürümü ve Git çalışma ağacı durumu
- Codex CLI sürümü
- EVREN modeli
- `native` / `textual` transport
- Standard / Coding / Custom preset ve değiştirilen limitler
- temiz, eşdeğer proje dizini
- kullanılan istemin byte-for-byte aynılığı
- `node_modules` / paket cache durumu
- canlı paket ağı kullanılıp kullanılmadığı

Kaydedilecek ölçümler:

- request, inference ve gerçek tool-call sayısı
- kesin EVREN input/output ve kümülatif oturum token'ı
- poll inference ve kesin poll token'ı
- kabul edilmiş compaction sayısı
- yaklaşık aktif ve tepe aktif bağlam
- kümülatif history replay, tool catalog ve current-input byte'ı
- yalnızca sağlayıcı kesin olarak veriyorsa kredi harcaması
- mevcutsa son güvenilir kalan kredi

Sonuç şablonu:

```text
scenario=
bridge_version=
codex_version=
model=
transport=
preset=
clean_project=
prompt_sha256=
package_cache_state=
live_network_install=
requests=
inferences=
tool_calls=
input_tokens=
output_tokens=
session_tokens=
poll_inferences=
poll_tokens=
compactions=
active_context_approx_tokens=
peak_context_approx_tokens=
history_replay_bytes=
tool_catalog_bytes=
current_input_bytes=
authoritative_credit_spend=unavailable
remaining_credits=
```

Uyarı: istem ve test koşulları kontrol edilmeden iki sonuç karşılaştırılabilir değildir. Testlerin geçmesi tek başına verimlilik kanıtı değildir. Esas v1.3 mimari kabulü, doğrulanmış bir Codex pencere replacement'ından sonra eski pre-compaction geçmişinin sonraki EVREN payload'ında bulunmamasıdır.

- [Calculator scenario](calculator.md)
- [Snake scenario](snake.md)
