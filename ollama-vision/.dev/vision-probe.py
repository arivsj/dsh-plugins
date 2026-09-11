import base64, json, time, urllib.request, sys
from PIL import Image, ImageDraw
model = sys.argv[1] if len(sys.argv) > 1 else "gemma4:e2b"
img = Image.new("RGB", (384, 256), (255, 255, 255))
d = ImageDraw.Draw(img)
d.ellipse((40, 60, 200, 200), fill=(30, 90, 220))
d.rectangle((230, 60, 340, 200), fill=(220, 200, 30))
img.save("/tmp/dsh-vision-test.png")
b64 = base64.b64encode(open("/tmp/dsh-vision-test.png","rb").read()).decode()
payload = {
  "model": model,
  "messages": [{"role":"user","content":"Describe this image in one short sentence: which shapes and colors do you see?","images":[b64]}],
  "stream": False,
  "keep_alive": "15m",
  "options": {"temperature": 0},
}
t0 = time.time()
req = urllib.request.Request("http://127.0.0.1:11434/api/chat", data=json.dumps(payload).encode(), headers={"Content-Type":"application/json"})
try:
    with urllib.request.urlopen(req, timeout=2400) as r:
        data = json.loads(r.read())
    print("MODEL", model, "ELAPSED %.1fs" % (time.time()-t0))
    print("RESPONSE:", json.dumps(data.get("message",{}).get("content","")[:800]))
    print("META:", json.dumps({k: v for k, v in data.items() if k not in ("message",)}))
except Exception as e:
    print("MODEL", model, "ERROR after %.1fs: %r" % (time.time()-t0, e))
    body = getattr(e, "read", lambda: b"")()
    print(body[:600])
