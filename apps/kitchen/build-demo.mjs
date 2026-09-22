import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
const out = new URL('demo-dist/', import.meta.url);
await mkdir(out, { recursive: true });
await cp(new URL('dist/', import.meta.url), out, { recursive: true });
for (const name of ['index.html', 'styles.css']) {
  const file = new URL(name, out);
  const content = (await readFile(file, 'utf8'))
    .replaceAll('href="/', 'href="/kitchen-demo/')
    .replaceAll('src="/', 'src="/kitchen-demo/')
    .replaceAll("url('/", "url('/kitchen-demo/");
  await writeFile(file, content);
}
