#!/usr/bin/env python3
"""Author stylized wall-art textures for the portfolio room (posters, sticky notes,
framed photos) — matches the reference's cozy-designer storytelling. Painterly/flat
to sit in the same abstraction level as the rest of the world."""
import math, os
from PIL import Image, ImageDraw, ImageFilter, ImageFont

OUT = "/Users/bachatt/Desktop/Portfolio 2026/web/public/art/"
os.makedirs(OUT, exist_ok=True)
F = "/System/Library/Fonts/Supplemental/"
def font(name, size):
    for p in (F+name, "/System/Library/Fonts/"+name):
        try: return ImageFont.truetype(p, size)
        except Exception: pass
    return ImageFont.load_default()

def lerp(a,b,t): return tuple(int(a[i]+(b[i]-a[i])*t) for i in range(3))

# ---------------- Travel poster "THE LONG WAY" (national-park style) ----------------
def poster():
    W,H=560,800
    im=Image.new("RGB",(W,H),(238,229,208))      # cream border
    d=ImageDraw.Draw(im)
    m=26
    ix0,iy0,ix1,iy1=m,m,W-m,H-m
    # sky gradient: warm cream top -> orange -> deep magenta bottom (sunset)
    TOP=(247,214,150); MID=(233,126,86); BOT=(120,52,92)
    for y in range(iy0,iy1):
        t=(y-iy0)/(iy1-iy0)
        c = lerp(TOP,MID,t/0.55) if t<0.55 else lerp(MID,BOT,(t-0.55)/0.45)
        d.line([(ix0,y),(ix1,y)],fill=c)
    cx=(ix0+ix1)//2
    # sun
    sunY=iy0+int((iy1-iy0)*0.42); sr=64
    d.ellipse([cx-sr,sunY-sr,cx+sr,sunY+sr],fill=(250,229,168))
    # distant mountain layers
    def ridge(base_y,color,amp,seed):
        pts=[(ix0,iy1)]
        import random; random.seed(seed)
        x=ix0
        while x<=ix1:
            y=base_y+int(amp*math.sin(x*0.012+seed)+amp*0.5*random.uniform(-1,1))
            pts.append((x,y)); x+=18
        pts+=[(ix1,iy1)]
        d.polygon(pts,fill=color)
    ridge(iy0+int((iy1-iy0)*0.52),(150,86,104),26,1)
    ridge(iy0+int((iy1-iy0)*0.60),(96,54,86),30,4)
    # lake band (reflection)
    lakeY=iy0+int((iy1-iy0)*0.66)
    d.rectangle([ix0,lakeY,ix1,iy1],fill=(74,44,78))
    for y in range(lakeY,iy1,3):
        t=(y-lakeY)/(iy1-lakeY)
        d.line([(ix0,y),(ix1,y)],fill=lerp((150,86,104),(50,30,60),t))
    # pine silhouettes foreground
    import random; random.seed(7)
    for i in range(11):
        px=ix0+int((ix1-ix0)*(i+0.5)/11)+random.randint(-8,8)
        ph=random.randint(60,120); pw=ph//3
        base=iy1-6
        for layer in range(4):
            yy=base-layer*ph//4
            d.polygon([(px-pw+layer*3,yy),(px+pw-layer*3,yy),(px,yy-ph//3)],fill=(28,30,34))
    # title
    ft=font("Arial Black.ttf",58)
    for i,(line) in enumerate(["THE LONG","WAY"]):
        w=d.textlength(line,font=ft)
        d.text((cx-w/2, iy0+22+i*60), line, font=ft, fill=(247,230,196))
    # bottom caption
    fc=font("Arial.ttf",20)
    cap="EXPLORE  ·  DESIGN  ·  REPEAT"
    w=d.textlength(cap,font=fc)
    d.text((cx-w/2, iy1-40), cap, font=fc, fill=(238,220,190))
    im.save(OUT+"poster_longway.png"); print("poster")

# ---------------- Sticky note ----------------
def sticky(fname, lines, size=380, col=(245,214,72), rot=0, doodle=False):
    im=Image.new("RGBA",(size,size),(0,0,0,0))
    d=ImageDraw.Draw(im)
    pad=18
    # paper with a subtle darker lower edge + slight shadow feel
    d.rectangle([pad,pad,size-pad,size-pad],fill=col+(255,))
    d.rectangle([pad,size-pad-14,size-pad,size-pad],fill=lerp(col,(0,0,0),0.10)+(255,))
    ft=font("Arial Rounded Bold.ttf", int(size*0.15))
    n=len(lines); lh=int(size*0.17); y=size//2-(n*lh)//2
    for ln in lines:
        w=d.textlength(ln,font=ft)
        d.text((size//2-w/2,y),ln,font=ft,fill=(46,40,30)); y+=lh
    if doodle:  # tiny mountain line
        yb=size-pad-40
        d.line([(size*0.3,yb),(size*0.42,yb-26),(size*0.5,yb),(size*0.6,yb-32),(size*0.72,yb)],
               fill=(46,40,30),width=4,joint="curve")
    if rot: im=im.rotate(rot,expand=True,resample=Image.BICUBIC)
    im.save(OUT+fname); print(fname)

# ---------------- Framed landscape photo ----------------
def photo(fname, palette):
    W,H=360,270
    im=Image.new("RGB",(W,H),(245,245,242))     # white frame
    d=ImageDraw.Draw(im); b=14
    sky_t,sky_b,mtn,water=palette
    for y in range(b,H-b):
        t=(y-b)/(H-2*b)
        d.line([(b,y),(W-b,y)],fill=lerp(sky_t,sky_b,min(1,t*1.4)))
    # mountains
    horizon=int(H*0.55)
    pts=[(b,horizon)]
    import random; random.seed(hash(fname)%1000)
    x=b
    while x<=W-b:
        pts.append((x,horizon-int(34*math.sin(x*0.02)+18*random.uniform(-1,1)))); x+=22
    pts+=[(W-b,horizon)]; d.polygon(pts+[(W-b,H-b),(b,H-b)],fill=mtn)
    # water
    d.rectangle([b,horizon,W-b,H-b],fill=water)
    for y in range(horizon,H-b,3):
        t=(y-horizon)/(H-b-horizon); d.line([(b,y),(W-b,y)],fill=lerp(mtn,water,t))
    im.save(OUT+fname); print(fname)

poster()
sticky("note_keep.png", ["KEEP","DESIGNING","KEEP","BUILDING"], size=400, col=(245,206,64), rot=3)
sticky("note_curious.png", ["Stay","Curious"], size=340, col=(247,216,88), rot=-4, doodle=True)
photo("photo_lake.png", ((150,120,180),(236,150,120),(70,54,92),(60,44,78)))
photo("photo_dusk.png", ((90,120,170),(210,160,150),(52,64,96),(44,54,84)))
print("DONE wallart")
