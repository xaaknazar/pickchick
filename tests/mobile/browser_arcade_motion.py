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
    # Check even speed across cell boundaries, not merely distinct positions.
    context=browser.new_context(viewport={'width':393,'height':852},reduced_motion='no-preference')
    signed_in(context);context.route('**/v1/**',lambda r:r.abort())
    page=context.new_page();page.goto(URL+'/games/pick-man')
    expect(page.get_by_test_id('pick-man-start')).to_be_visible(timeout=20000)
    page.get_by_test_id('pick-man-start').click();page.wait_for_timeout(300)
    values=page.get_by_test_id('pick-man-player').evaluate('''e=>new Promise(resolve=>{
      const rows=[],start=performance.now();function frame(t){rows.push({t,x:e.getBoundingClientRect().x});
      if(t-start<850)requestAnimationFrame(frame);else resolve(rows)}requestAnimationFrame(frame)})''')
    cell=page.get_by_test_id('pick-man-board').bounding_box()['width']/17
    speeds=[abs(b['x']-a['x'])/(b['t']-a['t']) for a,b in zip(values,values[1:])]
    steady=sum(abs(speed/(cell/205)-1)<.04 for speed in speeds)
    stalls=sum(speed<.001 for speed in speeds)
    assert steady>=len(speeds)*.85,(steady,speeds)
    assert stalls<=2,(stalls,speeds)
    jump=page.evaluate('''()=>new Promise((resolve,reject)=>{
      const actor=document.querySelector('[data-testid="pick-man-player"]'),
        board=document.querySelector('[data-testid="pick-man-board"]');
      const timeout=setTimeout(()=>reject(Error('Did not reach a mid-cell pause point')),1500);
      function frame(){const x=(actor.getBoundingClientRect().x-board.getBoundingClientRect().x)/(board.getBoundingClientRect().width/17);
        if(x%1>.6&&x%1<.85){clearTimeout(timeout);const before=actor.getBoundingClientRect().x;
          document.querySelector('[data-testid="pick-man-pause"]').click();
          setTimeout(()=>resolve(Math.abs(actor.getBoundingClientRect().x-before)),80);
        }else requestAnimationFrame(frame)}requestAnimationFrame(frame)})''')
    assert jump<cell*.25,jump
    frozen=page.get_by_test_id('pick-man-player').bounding_box();page.wait_for_timeout(200)
    assert frozen==page.get_by_test_id('pick-man-player').bounding_box()
    resume_jump=page.evaluate('''()=>new Promise(resolve=>{
      const actor=document.querySelector('[data-testid="pick-man-player"]'),before=actor.getBoundingClientRect().x;
      document.querySelector('[data-testid="pick-man-resume"]').click();
      setTimeout(()=>resolve(Math.abs(actor.getBoundingClientRect().x-before)),35)})''')
    assert resume_jump<cell*.35,resume_jump
    results.append({'game':'pick-man-continuity','steady_frames':steady,'intervals':len(speeds),'stalls':stalls,'pause_jump_px':jump,'resume_jump_px':resume_jump})
    context.close()
    # At a turn, positions remain on corridor centrelines. Reduced Motion has
    # only integer cell positions, while the normal renderer has sub-cell poses.
    for reduced in ['no-preference','reduce']:
        context=browser.new_context(viewport={'width':393,'height':852},reduced_motion=reduced)
        signed_in(context);context.route('**/v1/**',lambda r:r.abort())
        page=context.new_page();page.goto(URL+'/games/pick-man')
        expect(page.get_by_test_id('pick-man-start')).to_be_visible(timeout=20000)
        page.get_by_test_id('pick-man-start').click();page.keyboard.press('ArrowUp')
        poses=page.get_by_test_id('pick-man-player').evaluate('''e=>new Promise(resolve=>{
          const board=document.querySelector('[data-testid="pick-man-board"]').getBoundingClientRect(),cell=board.width/17;
          const rows=[],start=performance.now();function frame(t){const p=e.getBoundingClientRect();rows.push({x:(p.x-board.x)/cell,y:(p.y-board.y)/cell});
            if(t-start<950)requestAnimationFrame(frame);else resolve(rows)}requestAnimationFrame(frame)})''')
        integer=lambda value:abs(value-round(value))<.002
        assert all(integer(p['x']) or integer(p['y']) for p in poses),poses
        assert any(p['y']<9.9 for p in poses),poses
        if reduced=='reduce':assert all(integer(p['x']) and integer(p['y']) for p in poses),poses
        else:assert any(not integer(p['x']) or not integer(p['y']) for p in poses),poses
        results.append({'game':'pick-man-turn','reduced_motion':reduced,'corridor_centrelines':True})
        context.close()
    browser.close()
Path('.local').mkdir(exist_ok=True)
Path('.local/arcade-motion.json').write_text(json.dumps(results,indent=2))
print(json.dumps(results))
