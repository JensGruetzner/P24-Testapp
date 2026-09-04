# TestApp P24 Science Standalone

Standalone mobile-first browser test app for a P24 Science / ScienceMode4-compatible device.

## Files

```text
index.html
app.js
styles.css
manifest.webmanifest
src/
  index.js
  sciencemode4.js
```

## Android / STM32 USB CDC

This version tries WebUSB CDC/ACM first. That is intended for STM32 devices that enumerate as a USB serial / Virtual COM Port device and are visible in Android tools such as Serial USB Terminal.

Default WebUSB filters are configured for STMicroelectronics devices:

```js
{ vendorId: 0x0483, productId: 0x5740 }
{ vendorId: 0x0483 }
```

If your STM32 firmware uses a different VID/PID, change the filters in `app.js` inside `connect()`.

## Start on Android with Termux

```sh
cd /sdcard/Download/testapp-p24-science-standalone-webusb
python -m http.server 8000
```

Open on the same phone:

```text
http://localhost:8000/
```

`localhost` is important because browser USB APIs require a secure context. Do not open `index.html` via `file://`.

## Safety

Real stimulation commands are blocked unless `Enable real stimulation commands` is enabled.
Mock mode is disabled by default. All channels are disabled by default and start at `0 mA`.

## Version: transport diagnostics

This build separates WebSerial and WebUSB CDC/ACM in the Connection section. On desktop Chrome choose **WebSerial**. On Android Chrome choose **WebUSB CDC/ACM**. The Diagnostics section shows whether the browser exposes `navigator.usb` and/or `navigator.serial`, and logs the concrete connection error.

If the WebUSB device picker does not show the STM32, disconnect it from other apps such as Serial USB Terminal, reconnect the USB cable, and try again. If the device uses a custom VID/PID, the broad CDC class filters should still show it; otherwise add a concrete filter in `app.js`.
