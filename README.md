# UNDERCOVER

لعبة حفلات عربية مستقلة بواجهات RTL، وتدعم طريقتين:

- **جهاز واحد:** تمرير الهاتف بين 3–12 لاعبًا مع شاشات تسليم محايدة.
- **حفلة محلية:** كل لاعب يستخدم هاتفه داخل الغرفة نفسها، مع رمز غرفة واتصال WebSocket.

تتكون كل جلسة من خمس جولات. لا توجد حسابات أو قاعدة بيانات أو خدمات مدفوعة، وتبقى الغرف متعددة الهواتف في ذاكرة عملية الخادم.

## التشغيل المحلي

يتطلب Python 3.10 أو أحدث.

```bash
python -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
uvicorn app:app --reload
```

افتح `http://127.0.0.1:8000`. لاختبار وضع الحفلة من هواتف على الشبكة نفسها، شغّل الخادم على عنوان الشبكة المحلي:

```bash
uvicorn app:app --host 0.0.0.0 --port 8000
```

ثم افتح `http://LAN-IP:8000` على كل هاتف. استخدم هذا الأسلوب داخل شبكة موثوقة فقط؛ النشر العام يحتاج HTTPS.

## الاختبارات

```bash
python -m pip install -r requirements-dev.txt
python -m pytest -q
node tests/pass_play.js
```

فحص المتصفح الكامل اختياري ويحتاج Playwright وChromium:

```bash
node tests/browser_smoke.js
```

## البنية

- `app.py`: مسارات FastAPI وWebSocket.
- `undercover/rooms.py`: قواعد غرف Local Party والصلاحيات والنقاط.
- `undercover/data.py`: تحميل مكتبة الكلمات المشتركة.
- `static/data/word_pairs.json`: 140 زوجًا مع الفئات والتلميحات؛ يمكن توسيعه بإضافة عناصر بنفس البنية ومنح كل عنصر `id` فريدًا.
- `static/js/game.js`: منطق Pass & Play المستقل.
- `static/js/app.js`: واجهة الجهاز الواحد.
- `static/js/party.js`: واجهة الغرف متعددة الهواتف وإعادة الاتصال.
- `deploy/`: أمثلة مستقلة لـ systemd وNginx.
- `tests/`: اختبارات القواعد والواجهات والاتصال.

الغرف مؤقتة وتُفقد عند إعادة تشغيل الخادم. لذلك يجب تشغيل نسخة إنتاجية بعملية Uvicorn واحدة ما لم تُضف طبقة حالة مشتركة مستقبلًا. راجع [تعليمات النشر](docs/DEPLOYMENT.md).
