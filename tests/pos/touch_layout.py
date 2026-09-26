"""Touch layout acceptance across physical and Windows-scaled workstation viewports."""
import json

# CSS viewports: native resolutions and 125/150% Windows scaling equivalents.
WORKSTATION_SIZES = (
    (853, 480), (910, 512), (1024, 600), (1024, 768), (1093, 614),
    (1280, 720), (1280, 800), (1280, 1024), (1366, 705), (1366, 768),
    (1440, 900), (1536, 864), (1600, 900), (1920, 1080), (2560, 1440), (3840, 2160),
)


def audit_touch_layout(page, output, name, scope='[data-pos]'):
    original = page.viewport_size
    evidence = []
    for width, height in WORKSTATION_SIZES:
        page.set_viewport_size({'width': width, 'height': height})
        page.evaluate('async () => { await document.fonts.ready; }')
        report = page.locator(scope).last.evaluate('''root => {
          const problems = [];
          let count = 0;
          const scroll = [...document.querySelectorAll('*')]
            .filter(e => e.scrollHeight > e.clientHeight || e.scrollWidth > e.clientWidth)
            .map(e => [e, e.scrollLeft, e.scrollTop]);
          for (const e of root.querySelectorAll('button,[role=button]')) {
            if (!e.checkVisibility()) continue;
            let r = e.getBoundingClientRect();
            if (!r.width || !r.height) continue;
            count++;
            const label = (e.getAttribute('aria-label') || e.textContent).trim().replace(/\\s+/g, ' ').slice(0, 70);
            if (r.width < 43.5 || r.height < 43.5)
              problems.push({kind:'small', label, width:r.width, height:r.height});
            e.scrollIntoView({block:'nearest', inline:'nearest'});
            r = e.getBoundingClientRect();
            const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
            if (!hit || !(hit === e || e.contains(hit)))
              problems.push({kind:'unreachable', label});
            if (!e.children.length && (e.scrollWidth > e.clientWidth + 2 || e.scrollHeight > e.clientHeight + 2))
              problems.push({kind:'text-overflow', label});
          }
          for (const [e,x,y] of scroll) { e.scrollLeft=x; e.scrollTop=y; }
          return {count, problems};
        }''')
        evidence.append({'width': width, 'height': height, **report})
        if (width, height) in ((910, 512), (1024, 600), (1366, 768), (1920, 1080)) or report['problems']:
            page.screenshot(path=str(output / f'touch-{name}-{width}-{height}.png'))
    (output / f'touch-{name}.json').write_text(json.dumps(evidence, ensure_ascii=False, indent=2))
    page.set_viewport_size(original)
    assert all(r['count'] for r in evidence), f'{name}: no controls were checked'
    assert not any(r['problems'] for r in evidence), f'{name}: {[r for r in evidence if r["problems"]]}'
