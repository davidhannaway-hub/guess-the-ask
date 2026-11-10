# Daily reel: 2 houses, agent line then real meaning, prices never shown, ~12s, 1080x1920.
# Usage: python3 scripts/reel/reel.py ie '[{"i":5,"quote":"Compact yard to the rear."},{"i":2,"quote":"..."}]' OUTDIR
import json, math, subprocess, sys, os
from PIL import Image, ImageDraw, ImageFont

S = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(S, '..', '..'))
W, H, FPS = 1080, 1920, 30
F = lambda w, s: ImageFont.truetype(f'{S}/fonts/brico-{w}.ttf', s)
INK, WHITE, MUTE, TAPE = (12, 12, 12), (255, 255, 255), (150, 150, 150), (244, 195, 0)
STRIPE = [(0, 166, 81), (255, 210, 0), (247, 148, 29), (237, 28, 36)]

COUNTRY = {
    'ie': dict(name='IRELAND', cur='€', col=(0, 196, 98), noun='Irish'),
    'uk': dict(name='UK', cur='£', col=(230, 40, 50), noun='UK'),
}

def ease(t): t = max(0, min(1, t)); return 1 - (1 - t) ** 3
def wrap(d, text, font, width):
    words, lines, cur = text.split(), [], ''
    for w in words:
        t = (cur + ' ' + w).strip()
        if d.textlength(t, font=font) <= width: cur = t
        else: lines.append(cur); cur = w
    if cur: lines.append(cur)
    return lines

def text_alpha(base, xy, text, font, fill, a, anchor='la'):
    if a <= 0: return
    layer = Image.new('RGBA', base.size, (0, 0, 0, 0))
    ImageDraw.Draw(layer).text(xy, text, font=font, fill=fill + (int(255 * min(1, a)),), anchor=anchor)
    base.alpha_composite(layer)

def header(im, c, day):
    d = ImageDraw.Draw(im)
    f = F(800, 54)
    x = 60
    for word, col in (('GUESS THE ', WHITE), ('ASK', COUNTRY[c]['col'])):
        d.text((x, 66), word, font=f, fill=col); x += d.textlength(word, font=f)
    d.text((W - 60, 74), f"{COUNTRY[c]['name']}  ·  No. {day}", font=F(700, 34), fill=MUTE, anchor='ra')
    for i, col in enumerate(STRIPE): d.rectangle([i * W // 4, 150, (i + 1) * W // 4, 158], fill=col)

def price_str(c, v): return COUNTRY[c]['cur'] + f'{v:,}'

def frame_intro(t, c, day, n):
    im = Image.new('RGBA', (W, H), INK + (255,)); header(im, c, day); d = ImageDraw.Draw(im)
    col = COUNTRY[c]['col']
    lines = [('Three', WHITE), (f"{COUNTRY[c]['noun']} houses.", WHITE), ("What's the", WHITE), ('ask?', col)]
    y = 520
    for i, (s, cl) in enumerate(lines):
        a = ease((t - i * 0.12) / 0.25)
        text_alpha(im, (60, y + (1 - a) * 40), s, F(800, 150), cl, max(a, 1 if i == 0 else 0))
        y += 175
    a = ease((t - 0.8) / 0.3)
    text_alpha(im, (60, y + 60), 'From today\'s game. Answers in the comments.', F(400, 44), (200, 200, 200), a)
    return im

def frame_house(t, c, day, h, idx, n, reveal, dur):
    im = Image.new('RGBA', (W, H), INK + (255,)); header(im, c, day); d = ImageDraw.Draw(im)
    col = COUNTRY[c]['col']
    ph = Image.open(f"{REPO}/site/{h['img']}").convert('RGB')
    pw, phh = W, 720
    z = 1.0 + 0.06 * (t / dur)
    sw, sh = int(pw * z), int(phh * z)
    big = ph.resize((sw, int(sw * ph.height / ph.width)), Image.LANCZOS)
    if big.height < sh: big = ph.resize((int(sh * ph.width / ph.height), sh), Image.LANCZOS)
    ox, oy = (big.width - pw) // 2, (big.height - phh) // 2
    im.paste(big.crop((ox, oy, ox + pw, oy + phh)), (0, 158))
    d.rounded_rectangle([40, 198, 190, 268], 35, fill=INK)
    d.text((115, 233), f'{idx}/{n}', font=F(800, 40), fill=WHITE, anchor='mm')
    if idx == 1:
        hf = F(800, 50); hk = f"{n} {COUNTRY[c]['noun']} houses. What's the ask?"
        hw = d.textlength(hk, font=hf)
        d.rounded_rectangle([40, 790, 40 + hw + 48, 862], 36, fill=INK)
        d.text((64, 826), hk, font=hf, fill=WHITE, anchor='lm')
    text_alpha(im, (60, 900), h['area'], F(800, 62), WHITE, 1)
    text_alpha(im, (60, 975), h['title'], F(400, 40), MUTE, 1)
    a = ease((t - 0.3) / 0.25)
    text_alpha(im, (60, 1045), 'THE AGENT SAYS', F(700, 32), MUTE, a)
    qf = F(400, 54)
    for i, l in enumerate(wrap(d, '“' + h['quote'] + '”', qf, W - 120)[:2]):
        text_alpha(im, (60, 1088 + i * 66), l, qf, WHITE, a)
    y = 1250
    a = ease((t - h['mt']) / 0.25)
    if a > 0:
        lab = 'WHAT IT MEANS'; lf = F(800, 34)
        lw = d.textlength(lab, font=lf)
        layer = Image.new('RGBA', im.size, (0, 0, 0, 0)); ld = ImageDraw.Draw(layer)
        ld.polygon([(54, y - 4), (54 + lw + 36, y - 10), (54 + lw + 40, y + 48), (58, y + 52)], fill=TAPE + (int(255 * a),))
        ld.text((74, y + 4), lab, font=lf, fill=INK + (int(255 * a),))
        im.alpha_composite(layer)
        mf = F(800, 62)
        for i, l in enumerate(wrap(d, h['tr'], mf, W - 120)[:2]):
            text_alpha(im, (60, y + 74 + i * 72 + (1 - a) * 20), l, mf, TAPE, a)
    a = ease((t - h['mt'] - 0.4) / 0.25)
    text_alpha(im, (60, 1490), COUNTRY[c]['cur'] + ' ? ? ?', F(800, 104), col, a)
    return im

def render_scene(fn, dur, out):
    tmp = out[:-4] + '.part.mp4'
    p = subprocess.Popen(['ffmpeg', '-y', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', f'{W}x{H}', '-r', str(FPS), '-i', '-',
                          '-c:v', 'libx264', '-crf', '18', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', tmp], stdin=subprocess.PIPE)
    for i in range(int(dur * FPS)):
        p.stdin.write(fn(i / FPS).convert('RGB').tobytes())
    p.stdin.close()
    assert p.wait() == 0
    os.rename(tmp, out)

def frame_end(t, c, day, n):
    im = Image.new('RGBA', (W, H), INK + (255,)); header(im, c, day)
    col = COUNTRY[c]['col']
    a = ease(t / 0.25)
    text_alpha(im, (60, 520), 'Your guess?', F(800, 84), WHITE, a)
    text_alpha(im, (60, 640), 'Comment below.', F(800, 84), TAPE, ease((t - 0.1) / 0.2))
    text_alpha(im, (60, 880), 'Play all 7 in', F(400, 52), (200, 200, 200), ease((t - 0.2) / 0.2))
    text_alpha(im, (60, 945), 'today\'s game.', F(400, 52), (200, 200, 200), ease((t - 0.2) / 0.2))
    b = ease((t - 0.3) / 0.2)
    if b > 0:
        d = ImageDraw.Draw(im)
        layer = Image.new('RGBA', im.size, (0, 0, 0, 0)); ld = ImageDraw.Draw(layer)
        ld.rounded_rectangle([60, 1100, W - 60, 1260], 24, fill=col + (int(255 * b),))
        ld.text((W // 2, 1180), 'guesstheask.com', font=F(800, 76), fill=WHITE + (int(255 * b),), anchor='mm')
        im.alpha_composite(layer)
    return im

if __name__ == '__main__':
    c = sys.argv[1]; picks = json.loads(sys.argv[2]); outdir = sys.argv[3]; mode = sys.argv[4] if len(sys.argv) > 4 else 'video'
    game = json.load(open(f'{REPO}/site/houses/{c}/latest.json')); day = game['day']
    houses = []
    for p in picks:
        h = dict(game['houses'][p['i']]); h['quote'] = p['quote']; houses.append(h)
    n = len(houses)
    scenes = []
    for k, h in enumerate(houses):
        rev = False; dur = 5.6 if k == 0 else 5.0; h['mt'] = 2.4 if k == 0 else 2.0
        scenes.append(((lambda h, k, rev, dur: lambda t: frame_house(t, c, day, h, k + 1, n, rev, dur))(h, k, rev, dur), dur))
    scenes.append((lambda t: frame_end(t, c, day, n), 1.8))
    os.makedirs(outdir, exist_ok=True)
    if mode == 'stills':
        for k, (fn, dur) in enumerate(scenes):
            fn(dur - 0.05).convert('RGB').save(f'{outdir}/still-{k}.jpg', quality=88)
        sys.exit()
    files = []
    for k, (fn, dur) in enumerate(scenes):
        out = f'{outdir}/scene-{k}.mp4'; render_scene(fn, dur, out); files.append(out)
    with open(f'{outdir}/list.txt', 'w') as fh: fh.writelines(f"file '{f}'\n" for f in files)
    final = f'{outdir}/guess-the-ask-{c}-{game["date"]}.mp4'
    subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', f'{outdir}/list.txt',
                    '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo', '-c:v', 'copy', '-c:a', 'aac', '-shortest', '-movflags', '+faststart', final], check=True)
    print(final)
