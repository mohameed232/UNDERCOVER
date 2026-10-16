# نشر UNDERCOVER على Ubuntu 22.04

هذه خطوات تحضيرية ولا تنشر التطبيق تلقائيًا. تستخدم مجلدًا ومستخدمًا ومنفذًا وخدمة وملف Nginx مستقلة عن أي تطبيق قائم.

استبدل `undercover.example.com` بنطاق فرعي تملكه، ولا تفعّل خدمة عامة قبل توجيه DNS وتجهيز شهادة HTTPS.

## 1. إنشاء مستخدم ومجلد مستقلين

```bash
sudo adduser --system --group --home /opt/undercover undercover
sudo install -d -o undercover -g undercover /opt/undercover
```

انسخ هذا المستودع إلى `/opt/undercover` باستخدام Git أو أداة نقل ملفات. لا تستخدم مجلد NEXUS CONTROL أو بيئته الافتراضية أو خدمته أو منفذه.

## 2. تثبيت التطبيق

```bash
cd /opt/undercover
sudo -u undercover python3 -m venv .venv
sudo -u undercover .venv/bin/python -m pip install --upgrade pip
sudo -u undercover .venv/bin/python -m pip install -r requirements-dev.txt
sudo -u undercover .venv/bin/python -m pytest -q
sudo -u undercover .venv/bin/python -m pip install -r requirements.txt
```

يمكن إجراء الاختبارات في بيئة بناء منفصلة والاكتفاء بـ `requirements.txt` على خادم الإنتاج.

## 3. خدمة systemd مستقلة

راجع القيم في `deploy/undercover.service` ثم:

```bash
sudo cp deploy/undercover.service /etc/systemd/system/undercover.service
sudo systemctl daemon-reload
sudo systemctl enable --now undercover.service
sudo systemctl status undercover.service
curl --fail http://127.0.0.1:8011/health
```

يستخدم المثال المنفذ المحلي `8011` وعملية واحدة. لا ترفع عدد العمال؛ حالة الغرف موجودة في الذاكرة ولا تُشارك بين العمليات.

## 4. Nginx وHTTPS

احصل أولًا على شهادة صالحة للنطاق، مثل Let's Encrypt باستخدام Certbot وفق طريقة إعداد Nginx الحالية لديك. بعد توفر الملفات المشار إليها في المثال:

```bash
sudo cp deploy/nginx-undercover.conf /etc/nginx/sites-available/undercover
sudo ln -s /etc/nginx/sites-available/undercover /etc/nginx/sites-enabled/undercover
sudo nginx -t
sudo systemctl reload nginx
```

لا تستبدل ملفات المواقع القائمة. أنشئ ملفًا جديدًا وراجع تعارض `server_name` والمنفذ قبل إعادة التحميل. يتضمن المثال ترويسات WebSocket اللازمة واتصال HTTPS فقط للمستخدمين.

## 5. التحديث والرجوع

احتفظ بنسخة أو إصدار Git معروف قبل التحديث، ثم داخل `/opt/undercover`:

```bash
sudo -u undercover git pull --ff-only
sudo -u undercover .venv/bin/python -m pip install -r requirements.txt
sudo systemctl restart undercover.service
curl --fail http://127.0.0.1:8011/health
```

إعادة التشغيل تنهي الغرف النشطة حاليًا. نفّذ التحديث عندما لا توجد جلسات جارية.

## حدود النسخة الحالية

- الغرف مؤقتة داخل الذاكرة وتختفي مع إعادة التشغيل.
- يجب استخدام عملية خادم واحدة.
- لا توجد مراقبة مركزية أو تخزين دائم أو توزيع على عدة خوادم.
- رابط الدعوة متاح، أما رمز QR فغير مضمّن في هذه النسخة.
