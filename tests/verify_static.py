"""Static project integrity checks; does not contact real DB, Groq, Gmail, or n8n."""
from pathlib import Path
import json
root=Path(__file__).resolve().parents[1]
api=(root/'backend/src/controller.ts').read_text()
service=(root/'backend/src/service.ts').read_text()
migration=(root/'sql/002_pro_upgrade.sql').read_text()
frontend=(root/'frontend/app/page.tsx').read_text()
workflows=sorted((root/'n8n').glob('*.workflow.json'))
expected_paths={
    'recruitment-cv-intake','recruitment-ai-screening','recruitment-ranking',
    'recruitment-invite','recruitment-followup','recruitment-duplicate-check',
    'recruitment-cv-normalize','recruitment-job-match','recruitment-schedule-interview',
    'recruitment-status-notify','recruitment-daily-report'
}
assert len(workflows)==12, f'Expected 12 workflow JSON, found {len(workflows)}'
paths=set()
for w in workflows:
    d=json.loads(w.read_text())
    assert d.get('active') is False, f'{w.name}: imported workflow must require explicit Publish'
    nodes=d.get('nodes',[])
    assert len(nodes)>=7, f'{w.name}: only {len(nodes)} nodes; must have at least 7'
    names=[n['name'] for n in nodes]
    assert len(names)==len(set(names)), f'{w.name}: duplicate node names'
    node_names=set(names)
    for source, channels in d.get('connections',{}).items():
        assert source in node_names, f'{w.name}: unknown connection source {source}'
        for output in channels.get('main',[]):
            for edge in output:
                assert edge['node'] in node_names, f'{w.name}: connection target missing: {edge["node"]}'
    web=[n for n in nodes if n['type']=='n8n-nodes-base.webhook']
    calls=[n for n in nodes if n['type']=='n8n-nodes-base.httpRequest']
    if web:
        for n in web:
            assert n['parameters']['httpMethod']=='POST'
            assert n.get('webhookId'), f'{w.name}: missing webhookId'
            p=n['parameters']['path']
            assert p not in paths, f'Duplicate webhook path: {p}'
            paths.add(p)
        assert calls, f'{w.name}: webhook workflow must call backend'
        for call in calls:
            assert call['parameters']['url'].startswith('http://api:4000/api/automation/'), f'{w.name}: bad backend URL'
            assert 'x-flow-token' in str(call['parameters'].get('headerParameters',{})), f'{w.name}: missing backend auth header'
        assert any(n['type']=='n8n-nodes-base.if' for n in nodes), f'{w.name}: no IF validation/branch'
    starts=[n['name'] for n in nodes if n['type'] in {'n8n-nodes-base.webhook','n8n-nodes-base.scheduleTrigger','n8n-nodes-base.errorTrigger'}]
    graph={src:[edge['node'] for output in spec.get('main',[]) for edge in output] for src,spec in d.get('connections',{}).items()}
    reachable=set(); stack=list(starts)
    while stack:
        current=stack.pop()
        if current in reachable: continue
        reachable.add(current)
        stack.extend(graph.get(current,[]))
    assert reachable==node_names, f'{w.name}: unreachable nodes {node_names-reachable}'
assert paths==expected_paths, f'Webhook paths mismatch: {paths ^ expected_paths}'
error_workflow=json.loads((root/'n8n/recruitment-error-monitor.workflow.json').read_text())
assert any(n['type']=='n8n-nodes-base.errorTrigger' for n in error_workflow['nodes'])
for endpoint in [
    'verify-cv','check-duplicate-cv','normalize-cv','job-match','schedule-interview',
    'notify-candidate-status','daily-report','log-error','screen-cv','recalculate-ranking',
    'send-reminders','send-invite'
]:
    assert f"@Post('automation/{endpoint}')" in api, f'missing route {endpoint}'
for workflow_key in ['cv-duplicate-check','cv-normalize','job-match','status-notify','interview-schedule']:
    assert f"'{workflow_key}'" in service, f'missing dispatch mapping {workflow_key}'
for tbl in ['automation_runs','candidate_rankings','cv_verified_at','reminder_sent_at','email_attempt_started_at']:
    assert tbl in migration, tbl
assert 'AUTOMATION_PRO_ENABLED' in (root/'backend/Dockerfile').read_text()
assert 'GroqService' in (root/'backend/src/groq.ts').read_text()
assert 'localhost:5679' in frontend
assert 'setInterval(()=>void load(),5000)' in frontend
assert 'GROQ_MODEL=openai/gpt-oss-120b' in (root/'.env.example').read_text()
assert 'RECRUITMENT_NOTIFY_EMAIL' in (root/'.env.example').read_text()
assert '.env' in (root/'.gitignore').read_text(), 'Ignore local secrets'
assert 'https://api.groq.com/openai/v1/chat/completions' in (root/'backend/src/groq.ts').read_text()
assert 'GROQ_API_KEY' in (root/'docker-compose.yml').read_text()
assert 'GEMINI_API_KEY' not in (root/'backend/src/service.ts').read_text()
assert 'Gemini' not in frontend
print('PASS: 12 n8n workflow JSON files; each has >=7 nodes; unique webhook paths; auth, routes, Groq config and project integrity checks passed.')
