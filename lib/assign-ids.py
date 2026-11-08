# Google Harness² 6868817 selection.assign_ids ordering, Apache-2.0.
import sys, json, random, hashlib
x = json.load(sys.stdin)
labels = sorted(x['labels'])
seed = int(hashlib.sha1(f"{x['task']}|{x['k']}|{x['mode']}".encode()).hexdigest()[:12], 16)
random.Random(seed).shuffle(labels)
print(json.dumps(labels))
