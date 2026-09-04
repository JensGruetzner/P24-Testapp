# TestApp P24 Science - Standalone

Reduced standalone package containing only the mobile TestApp and the required JavaScript library files.

## Start locally on Android / Termux

```sh
cd /sdcard/Download/testapp-p24-science-standalone
python -m http.server 8000
```

Open on the same smartphone:

```text
http://localhost:8000/
```

Do not open `index.html` via `file://`; WebSerial needs localhost or HTTPS.

## Included files

```text
index.html
app.js
styles.css
manifest.webmanifest
src/index.js
src/sciencemode4.js
```
