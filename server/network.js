'use strict';
const os = require('os');
const { execFileSync } = require('child_process');

/** Private IPv4 addresses of this machine, Wi-Fi/Ethernet first. */
function lanAddresses() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const [name, list] of Object.entries(ifaces)) {
    for (const addr of list || []) {
      if (addr.family !== 'IPv4' && addr.family !== 4) continue;
      if (addr.internal) continue;
      if (addr.address.startsWith('169.254.')) continue; // link-local
      out.push({ name, address: addr.address });
    }
  }
  // macOS: en0 is normally Wi-Fi; prefer en*/eth*/wlan* over VPN/bridge interfaces
  const rank = (n) => (/^en0$/.test(n) ? 0 : /^(en|eth|wlan|wl)/.test(n) ? 1 : 2);
  out.sort((a, b) => rank(a.name) - rank(b.name));
  return out.map((a) => a.address);
}

/** Bonjour name that iPhones can resolve, e.g. "Abhinands-MacBook-Pro.local". */
function localHostname() {
  let name = '';
  if (process.platform === 'darwin') {
    try {
      name = execFileSync('scutil', ['--get', 'LocalHostName'], { encoding: 'utf8', timeout: 2000 }).trim();
    } catch (e) {
      name = '';
    }
  }
  if (!name) name = os.hostname().replace(/\.local$/i, '');
  name = name.replace(/[^A-Za-z0-9-]/g, '-');
  return name ? `${name}.local` : null;
}

function isLoopback(address) {
  if (!address) return false;
  return address === '::1' || address.startsWith('127.') || address.startsWith('::ffff:127.');
}

module.exports = { lanAddresses, localHostname, isLoopback };
