#!/usr/bin/env node
// Extract the Firebase refreshToken + apiKey from a logged-in Lovable browser profile.
// Reads IndexedDB via a headless Playwright session, then writes them to .env.
//
// Usage:
//   node scripts/extract-firebase-refresh.mjs --profile-dir /tmp/lovagentic-sniff
//
// Output:
//   - prints `LOVABLE_REFRESH_TOKEN=...` and `LOVABLE_FIREBASE_API_KEY=...`
//   - exits non-zero on failure

import { chromium } from 'playwright';

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const PROFILE = arg('--profile-dir', '/tmp/lovagentic-sniff');
const HEADLESS = process.argv.includes('--no-headless') ? false : true;

async function main() {
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    headless: HEADLESS,
    viewport: { width: 1024, height: 768 },
  });
  const page = await ctx.newPage();
  await page.goto('https://lovable.dev/', { waitUntil: 'domcontentloaded' });
  // Give Firebase JS a moment to hydrate IDB
  await page.waitForTimeout(2500);

  const auth = await page.evaluate(async () => {
    return await new Promise((resolve, reject) => {
      const req = indexedDB.open('firebaseLocalStorageDb');
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        try {
          const db = req.result;
          const tx = db.transaction('firebaseLocalStorage', 'readonly');
          const store = tx.objectStore('firebaseLocalStorage');
          const all = store.getAll();
          all.onsuccess = () => {
            const items = all.result || [];
            const user = items.find((it) =>
              typeof it?.fbase_key === 'string' &&
              it.fbase_key.startsWith('firebase:authUser:'),
            );
            if (!user) return resolve(null);
            // fbase_key format: firebase:authUser:<apiKey>:[DEFAULT]
            const parts = user.fbase_key.split(':');
            const firebaseApiKey = parts[2] || null;
            const refreshToken = user?.value?.stsTokenManager?.refreshToken || null;
            const accessToken = user?.value?.stsTokenManager?.accessToken || null;
            const expirationTime = user?.value?.stsTokenManager?.expirationTime || null;
            const userId = user?.value?.uid || null;
            const email = user?.value?.email || null;
            resolve({ firebaseApiKey, refreshToken, accessToken, expirationTime, userId, email });
          };
          all.onerror = () => reject(all.error);
        } catch (e) {
          reject(e);
        }
      };
    });
  });

  await ctx.close();

  if (!auth || !auth.refreshToken || !auth.firebaseApiKey) {
    console.error('❌ No Firebase auth state found. Are you logged into lovable.dev in this profile?');
    process.exit(2);
  }

  // Print as JSON for easy capture
  console.log(JSON.stringify(auth, null, 2));
}

main().catch((e) => {
  console.error('Error:', e?.message || e);
  process.exit(1);
});
