# Local optional experiment: pip install rapidocr-onnxruntime==1.4.4
# Manual crop ablation; never part of the Mini Program or a Tencent replacement.
import json, time, hashlib, os
from pathlib import Path
from rapidocr_onnxruntime import RapidOCR
from PIL import Image
root=Path(__file__).resolve().parents[2]
private=root/'test-data/private/v233'
private.mkdir(mode=0o700,exist_ok=True)
engine=RapidOCR()
cases=[('A','e2cbeedb691c92222a27aaa7185c572e',(25,510,1185,1410)),('B','3a5c04743e548136f25c7ffbf3f3a26a',(30,510,1020,850)),('C','2db1829c75cb1264aaf95cdc5ad8fdfc',(25,510,1185,1280)),('D','a759a0db3a66a4e32c380c75fbca31f8',None)]
for id,name,crop in cases:
    p=root/'test-data/recognition'/f'{name}.jpg'
    for mode in ['full','crop'] if crop else ['full']:
        im=Image.open(p)
        offset=(0,0)
        if mode=='crop': im=im.crop(crop);offset=crop[:2]
        import numpy as np
        start=time.perf_counter();res,t=engine(np.array(im)[:,:,::-1]);elapsed=(time.perf_counter()-start)*1000
        lines=[];boxes=[];scores=[]
        for points,text,score in res or []:
            xs=[p[0]+offset[0] for p in points];ys=[p[1]+offset[1] for p in points]
            lines.append(text);boxes.append(dict(x=min(xs),y=min(ys),width=max(xs)-min(xs),height=max(ys)-min(ys)));scores.append(score)
        data=dict(engine='rapidocr-onnxruntime==1.4.4',sample=id,mode=mode,imageSha256=hashlib.sha256(p.read_bytes()).hexdigest(),crop=crop if mode=='crop' else None,elapsedMs=elapsed,result=dict(mock=False,lines=lines,boxes=boxes,scores=scores))
        out=private/f'rapid-{id}-{mode}.json'
        out.write_text(json.dumps(data,ensure_ascii=False));out.chmod(0o600)
        print(json.dumps(dict(id=id,mode=mode,elapsedMs=round(elapsed),lines=len(lines))),flush=True)
