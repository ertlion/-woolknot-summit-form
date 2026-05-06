# Woolknot — Summit Lead Form

Istanbul Marketing Summit '26 için tasarlanmış üyelik başvuru formu.
Statik HTML + nginx Docker container. Coolify ile deploy edilir.

---

## E-posta Servisi: FormSubmit.co (Ücretsiz, Sınırsız)

Form gönderimleri **marketing@woolknot.com** adresine gelir.
Aynı patern sarkhali.net ve trt1.com'da kullanıldı, sorunsuz çalışıyor.

### İlk kullanım (tek seferlik)

1. Form ilk kez doldurulduğunda FormSubmit `marketing@woolknot.com`'a bir **verification mail** gönderir
2. Mail içindeki **"Confirm your email"** butonuna tıkla
3. Bundan sonra tüm submission'lar otomatik gelir

> Not: Verification olmadan ikinci submission CAPTCHA istiyor. İlk doğrulamadan sonra `_captcha=false` ile sessiz çalışır.

---

## Coolify Deployment

### 1. GitHub Repo
```bash
cd ~/Desktop/Woolknot/woolknot-summit-form
git init
git add .
git commit -m "feat: woolknot summit lead form"
gh repo create woolknot-summit-form --private --source=. --push
```

### 2. Coolify Panel
- **Resources → New → Application → GitHub**
- **Repository:** `woolknot-summit-form`
- **Build Pack:** Dockerfile
- **Port:** 80
- **Domain:** `summit.woolknot.com` (DNS A → 46.225.116.245)
- **Health Check:** `/health`

SSL Coolify tarafından otomatik (Let's Encrypt).

---

## Local Test

```bash
cd ~/Desktop/Woolknot/woolknot-summit-form
docker build -t woolknot-form .
docker run -p 8080:80 woolknot-form
# http://localhost:8080
```

---

## Form Alanları → Mail İçeriği

FormSubmit her submission'ı şu formatta gönderir (table template):

| Alan | Değer |
|------|-------|
| fullname | Ahmet Yılmaz |
| email | ahmet@example.com |
| phone | +905321234567 |
| company | Acme Corp |
| interest | ev,proje |
| source | istanbul-marketing-summit-2026 |

**Konu:** "Yeni Woolknot Topluluk Başvurusu"
**Alıcı:** marketing@woolknot.com
