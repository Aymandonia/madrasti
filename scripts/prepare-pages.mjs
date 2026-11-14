import { mkdir, copyFile, writeFile } from 'node:fs/promises';
const api = new URL(process.env.MADRASTI_API_URL || 'https://invalid.invalid');
if (api.protocol !== 'https:' || api.hostname.endsWith('.invalid') || api.username || api.password || api.search || api.hash || !['/', '/api', '/api/'].includes(api.pathname)) {
  throw new Error('Set GitHub Actions variable MADRASTI_API_URL to the HTTPS URL of your Render service');
}
await mkdir('public', { recursive: true });
for (const file of ['index.html', 'cloud.js']) await copyFile(file, 'public/' + file);
await writeFile('public/config.js', 'window.MADRASTI_API = ' + JSON.stringify(api.origin + '/api') + ';\n');

