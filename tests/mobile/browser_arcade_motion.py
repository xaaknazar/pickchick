"""Verify sub-cell animation and frozen pause on the exported games, not just engine ticks."""
import json
import os
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import expect, sync_playwright
from account_fixture import signed_in
URL=os.environ.get('MOBILE_RECOVERY_URL','http://127.0.0.1:4182').rstrip('/')
assert urlparse(URL).hostname in ('127.0.0.1','localhost')
results=[]
with sync_playwright() as p:
    browser=p.chromium.launch()
    for route,start,pause,resume,actor,axis in [
        ('pick-blocks','blocks-start','blocks-pause','blocks-resume','blocks-falling-piece','y'),
        ('pick-man','pick-man-start','pick-man-pause','pick-man-resume','pick-man-player','x')]:
        context=browser.new_context(viewport={'width':393,'height':852},reduced_motion='no-preference')
        signed_in(context);context.route('**/v1/**',lambda r:r.abort())
        page=context.new_page();page.goto(URL+'/games/'+route)
        expect(page.get_by_test_id(start)).to_be_visible(timeout=20000)
        page.get_by_test_id(start).click();expect(page.get_by_test_id(actor)).to_be_attached()
        values=page.get_by_test_id(actor).evaluate('''(element,axis)=>new Promise(resolve=>{
          const values=[],start=performance.now();
          const frame=now=>{values.push(element.getBoundingClientRect()[axis]);
            if(now-start>=650)resolve(values);else requestAnimationFrame(frame)};
          requestAnimationFrame(frame);
        })''',axis)
        distinct=len(set(round(v,2) for v in values))
        assert distinct>=10,(route,values)
        page.get_by_test_id(pause).click();expect(page.get_by_test_id(resume)).to_be_visible()
        page.wait_for_timeout(120)
        before=page.get_by_test_id(actor).bounding_box();page.wait_for_timeout(350)
        assert before==page.get_by_test_id(actor).bounding_box(),route
        results.append({'game':route,'frames':len(values),'distinct_positions':distinct,'pause_frozen':True})
        context.close()
    browser.close()
Path('.local').mkdir(exist_ok=True)
Path('.local/arcade-motion.json').write_text(json.dumps(results,indent=2))
print(json.dumps(results))
