'use strict';

const webPush = require('web-push');

const keys = webPush.generateVAPIDKeys();
process.stdout.write(`VAPID_PUBLIC_KEY=${keys.publicKey}\nVAPID_PRIVATE_KEY=${keys.privateKey}\n`);
