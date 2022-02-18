# Obscura

Obscura is a simple node app that runs on a RaspberryPi (in my case, a Pi Zero 2 W). It can be used to stream live video and take pictures remotely over the web, but it's principal function is to periodically take a snapshot and provide a streaming interface to allow [time-lapse](https://en.wikipedia.org/wiki/Time-lapse_photography) photography.

## Features
* Auto-adjusts quality & frame-rate to suit network conditions.
* Simple, embedded API for viewing live video, taking HQ photos and playing time-lapses
* Export as H264 using GPU (requires ffmpeg is installed)

![required](https://github.com/MatAtBread/obscura/raw/master/screenshot.jpg)

## Requirements
A RaspberryPi with enabled camera (see raspi-config). Developed and tested on RaspberryPi buster, later OS versions may need an additional download (for camera / MMAL support) as the camera module is built on that API for performance.

## Installation
```npm i pi-obscura``` 

Alternatively, clone (and `npm i`) the repo at https://github.com/MatAtBread/obscura.git and run with [pm2](https://pm2.keymetrics.io/). In this configuration, you can aurto-deploy updates remotely (see [Security](#security) for more info).

I run it with [pm2](https://pm2.keymetrics.io/) to ensure it starts up after a reboot or if the app crashes.

You can then view your images & video at `http://<your-pi-host>:8000`

## Security
The app has no known security issues, however, connecting a Raspberry Pi to the internet without any protection is unwise. Potential mitigation strategies are:
* Don't install anything else on the Pi. I recommend a "lite, headless" OS install to keep the performance up. Do not install browers or anything that stores passwords.
* Don't save any passwords for other services you use on the Pi. In that case, even if your Pi is hacked (brute force on a Pi connected to the internet isn't very hard), there will be nothing of value other than your images.
* Disable PasswordAuthetication in [sshd](https://www.e2enetworks.com/help/knowledge-base/how-to-enable-disable-password-based-authentication-for-ssh-access-to-server/) and only allow access via pre-installed keys.
* Don't use NAT or put a hole in your firewall that directly accesses the service (default port is 8000). If you want to see you images remotely, use SSH and a tunnel: ` ssh -L 8001:localhost:8000` and access the service as `http://localhost:8001`

The `/admin` page offers auto-deployment from source github repo (if you installed from github & run under pm2). **If you make you Obscura available on the internet, any one can redeploy to your server**. It is recommended that Obscura is not available to the public (ie only done on a home network, VPN or via a SSH tunnel) unless you disable this feature.

## TO DO
* Add some kind of simple auth to the `/admin` URL
* Add options for managing storage (it will at present eventually fill your SD card)
