"""Generate JS prompt assets from the pinned Google implementation (no inference)."""
import sys,json,pathlib
root=pathlib.Path(sys.argv[1]).resolve(); sys.path.insert(0,str(root))
from harness2.core import prompts as p
from harness2.core.spec import BenchPrompts
bp=BenchPrompts(work='@@WORK@@')
# Only substrate vocabulary changes. All reasoning/selection instructions remain upstream.
st=p._SURFACE_TEXTS['opencode']
def native(s):
 for a,b in [('systemprompt.md','system.md'),('LongTermMEMORY.md','memory.md'),('tool_descriptions/tool_guidance.md','tool-guidance.md'),('plugin/<name>.ts','plugins/<name>.js'),('plugin/','plugins/'),('OpenCode','DSH'),('TypeScript','JavaScript')]: s=s.replace(a,b)
 return s
p._SURFACE_TEXTS['dsh']=p._SurfaceText(native(st.surface_md)+'\n\nDSH middleware modules export apply(agentCtx), registering scoped native events: tools/pre-execute, tools/post-execute, agent/pre-step, agent/turn-stopping. Registrations are disposed with the executor.\n',native(st.inv),native(st.dom),native(st.tts_surface))
if len(sys.argv)>2 and sys.argv[2]=='--cases':
 cases=json.load(sys.stdin);answers=[]
 for c in cases:
  bp=BenchPrompts(work=c['task']); k=c.get('k',1); mode=c.get('mode','sequential'); t=c.get('round',1); index=c.get('index',1)
  if c['kind']=='propose': text=p.propose(bp,c['dim'],'dsh',k=k,index=index,round_t=t if mode=='sequential' and k>1 else None)
  elif c['kind']=='compose': text=p.aggregate(bp,'dsh',k=k,index=index) if mode=='parallel' or k==1 else p.compose_round(bp,'dsh',t=t,k=k)
  elif c['kind']=='select': text=p.select(bp,index,pool_kind='finals')
  else: text=p.experience(bp)
  answers.append(text)
 print(json.dumps(answers));sys.exit(0)
def slots(s):
 for n,t in [(20018,'N'),(10008,'PREVCOUNT'),(10009,'K'),(10007,'T'),(10003,'INDEX')]: s=s.replace(str(n),'@@'+t+'@@')
 return s
out={}
for single in (True,False):
 k=1 if single else 10009
 for seq in (True,False):
  for dim in ('INV','DOM'):
   for first in ([True,False] if seq and not single else [True]):
    t=(1 if first else 10007) if seq else None
    key=f'propose:{dim}:{"one" if single else "many"}:{"first" if seq and first else "later" if seq else "parallel"}'
    out[key]=slots(p.propose(bp,dim,'dsh',k=k,index=10003,round_t=t))
 out[f'aggregate:{"one" if single else "many"}']=slots(p.aggregate(bp,'dsh',k=k,index=10003))
 for phase in (['first-final'] if single else ['first','middle','final']):
  t=1 if phase.startswith('first') else k if phase=='final' else 10007
  value=p.compose_round(bp,'dsh',t=t,k=k)
  if phase=='final': value=value.replace(str(t),'@@T@@')
  out[f'compose:{"one" if single else "many"}:{phase}']=slots(value)
out['select']=slots(p.select(bp,10009,pool_kind='finals')).replace('@@K@@','@@COUNT@@')
out['reflect']=p.experience(bp)
out['markers']=list(__import__('harness2.core.context',fromlist=['GRADER_VERDICT_MARKERS']).GRADER_VERDICT_MARKERS)
print(json.dumps(out,ensure_ascii=False,indent=2))
