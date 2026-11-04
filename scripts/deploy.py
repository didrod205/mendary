#!/usr/bin/env python3
"""Build and deploy Mendary to Cloudflare Workers with the plain REST API (no wrangler needed).

Environment variables (never commit them):
  CF_API_TOKEN, CF_ACCOUNT_ID, PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET,
  KV_NAMESPACE_ID (optional, created if missing), WORKER_NAME (default mendary),
  DEMO_BUYER_EMAIL, DEMO_BUYER_PASSWORD (sandbox test buyer shown on the page),
  CUSTOM_HOSTNAME + CF_ZONE_ID (optional custom domain)
"""
import json, os, pathlib, urllib.request, uuid

ROOT = pathlib.Path(__file__).resolve().parent.parent
API = 'https://api.cloudflare.com/client/v4'
E = os.environ


def call(method, path, data=None, ctype='application/json'):
    body = data if isinstance(data, (bytes, type(None))) else json.dumps(data).encode()
    req = urllib.request.Request(API + path, data=body, method=method,
                                 headers={'Authorization': 'Bearer ' + E['CF_API_TOKEN'], 'Content-Type': ctype})
    try:
        return json.load(urllib.request.urlopen(req))
    except urllib.error.HTTPError as e:
        return json.loads(e.read() or b'{}')


def build():
    html = (ROOT / 'web' / 'index.html').read_text()
    (ROOT / 'src' / 'page.mjs').write_text('// Generated from web/index.html by scripts/deploy.py\nexport const PAGE = ' + json.dumps(html) + ';\n')


def main():
    build()
    acc = E['CF_ACCOUNT_ID']
    name = E.get('WORKER_NAME', 'mendary')
    kv = E.get('KV_NAMESPACE_ID')
    if not kv:
        r = call('POST', f'/accounts/{acc}/storage/kv/namespaces', {'title': name + '-data'})
        kv = r['result']['id']
        print('created KV namespace', kv)
    bindings = [
        {'type': 'ai', 'name': 'AI'},
        {'type': 'kv_namespace', 'name': 'DB', 'namespace_id': kv},
        {'type': 'plain_text', 'name': 'PAYPAL_CLIENT_ID', 'text': E['PAYPAL_CLIENT_ID']},
        {'type': 'secret_text', 'name': 'PAYPAL_CLIENT_SECRET', 'text': E['PAYPAL_CLIENT_SECRET']},
        {'type': 'plain_text', 'name': 'DEMO_BUYER_EMAIL', 'text': E.get('DEMO_BUYER_EMAIL', '')},
        {'type': 'plain_text', 'name': 'DEMO_BUYER_PASSWORD', 'text': E.get('DEMO_BUYER_PASSWORD', '')},
        {'type': 'plain_text', 'name': 'REPO_URL', 'text': E.get('REPO_URL', 'https://github.com/didrod205/mendary')},
    ]
    meta = {'main_module': 'worker.mjs', 'compatibility_date': '2025-09-01', 'bindings': bindings}
    b = '----mendary' + uuid.uuid4().hex
    parts = [('metadata', None, 'application/json', json.dumps(meta).encode())]
    for f in ['worker.mjs', 'page.mjs', 'policy.mjs']:
        parts.append((f, f, 'application/javascript+module', (ROOT / 'src' / f).read_bytes()))
    body = b''
    for n, fn, ct, data in parts:
        body += f'--{b}\r\nContent-Disposition: form-data; name="{n}"'.encode()
        if fn:
            body += f'; filename="{fn}"'.encode()
        body += f'\r\nContent-Type: {ct}\r\n\r\n'.encode() + data + b'\r\n'
    body += f'--{b}--\r\n'.encode()
    r = call('PUT', f'/accounts/{acc}/workers/scripts/{name}', body, 'multipart/form-data; boundary=' + b)
    print('upload', r.get('success'), [e.get('message') for e in r.get('errors', [])])
    r = call('POST', f'/accounts/{acc}/workers/scripts/{name}/subdomain', {'enabled': True})
    print('workers.dev', r.get('success'))
    host = E.get('CUSTOM_HOSTNAME')
    if host:
        r = call('PUT', f'/accounts/{acc}/workers/domains', {'hostname': host, 'service': name, 'zone_id': E['CF_ZONE_ID'], 'environment': 'production'})
        print('custom domain', host, r.get('success'), [e.get('message') for e in r.get('errors', [])])


if __name__ == '__main__':
    import sys
    if '--build-only' in sys.argv:
        build(); print('built src/page.mjs')
    else:
        main()
