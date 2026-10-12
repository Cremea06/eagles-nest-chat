// CHG-115 — count stored usernames that fail today's CHG-051 check(). Prints only the count, never a name.
// Run on the VPS: node tools/audit-usernames.js users.json
const fs = require('fs');
const path = require('path');
const rule = require('../lib/username');
const file = path.resolve(process.argv[2] || path.join(__dirname, '..', 'users.json'));
const users = JSON.parse(fs.readFileSync(file, 'utf8'));
const bad = users.filter((u) => !rule.check(u && u.username, { email: u && u.email }).ok).length;
console.log(`${bad} of ${users.length} stored usernames fail today's CHG-051 rules`);
process.exitCode = bad ? 1 : 0;
