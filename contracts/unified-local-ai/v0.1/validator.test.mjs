import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {evaluateRequest,validateCapability} from './validator.mjs';

const root=dirname(fileURLToPath(import.meta.url));
const read=(name)=>JSON.parse(readFileSync(join(root,'fixtures',name), 'utf8'));
const mutation=(base,fn)=>{const copy=structuredClone(base);fn(copy);return copy};
const cases=[read('studio.json'),read('local3d.json'),read('genex.json')];

for(const cap of cases){
  test(`${cap.projectId}: pinned code-only metadata accepted without execution authority`,()=>{
    const proof=validateCapability(cap);
    assert.equal(proof.safeToExecute,false);
    assert.equal(proof.runtimeStatus,'UNKNOWN');
    assert.deepEqual(proof.authorizedActions,[]);
    assert.equal(proof.printQualified,false);
    assert.equal(evaluateRequest(cap,'inspect_static_descriptor').decision,'STATIC_METADATA_ONLY');
  });
  test(`${cap.projectId}: execution, network, GPU, VM, Blender, printing all fail closed`,()=>{
    for(const action of ['submit_job','open_external_mcp','infer_gpu_image','run_vm','run_native_plugin','run_shell','send_to_printer','cloud_fallback','start_service', 'run_blender',null]){
      const verdict=evaluateRequest(cap,action);
      assert.equal(verdict.decision,'DENY');
      assert.equal(verdict.sideEffects,false);
    }
  });
}

test('unknown project, wrong project repository or mode rejected',()=>{
  const cap=cases[0];
  for(const broken of [
    mutation(cap,x=>x.projectId='office'),
    mutation(cap,x=>x.repository='other/repo'),
    mutation(cap,x=>x.declaredModes=['TRIPOSR_MANUAL_PER_IMAGE_GATED']),
    mutation(cap,x=>x.declaredModes.push(x.declaredModes[0])),
    mutation(cap,x=>x.upstreamCommit='abc')
  ]) assert.throws(()=>validateCapability(broken));
});

test('reported activity is never promoted to live host status',()=>{
  const cap=cases[0];
  for(const broken of [
    mutation(cap,x=>x.snapshot.hostVerified=true),
    mutation(cap,x=>x.snapshot.runtimeStatus='ONLINE'),
    mutation(cap,x=>x.snapshot.port=4178),
    mutation(cap,x=>x.snapshot.hostIdentity='Chris'),
    mutation(cap,x=>x.snapshot.evidence='VM_ATTESTED')
  ]) assert.throws(()=>validateCapability(broken));
});

test('permission escalation and paid egress rejected',()=>{
  const cap=cases[1];
  for(const broken of [
    mutation(cap,x=>x.policy.localOnly=false),
    mutation(cap,x=>x.policy.cloudFallback='AUTO'),
    mutation(cap,x=>x.policy.networkEgress='ALLOW'),
    mutation(cap,x=>x.policy.gpuInference='APPROVED'),
    mutation(cap,x=>x.gpu.approvedForInference=true),
    mutation(cap,x=>x.gpu.leaseState='FREE'),
    mutation(cap,x=>x.policy.vmExecution='ENABLED'),
    mutation(cap,x=>x.policy.nativePlugins='ENABLED'),
    mutation(cap,x=>x.policy.jobSubmission='APPROVED'),
    mutation(cap,x=>x.policy.printer='APPROVED'),
    mutation(cap,x=>x.policy.humanReview='OPTIONAL')
  ]) assert.throws(()=>validateCapability(broken));
});

test('provenance, print qualification and shared scheduler remain blocked',()=>{
  const cap=cases[2];
  for(const broken of [
    mutation(cap,x=>x.result.trusted=true),
    mutation(cap,x=>x.result.printQualified=true),
    mutation(cap,x=>x.result.approvedForPrinter=true),
    mutation(cap,x=>x.result.fabricationAction='PRINT'),
    mutation(cap,x=>x.integration.adapter='CONNECTED'),
    mutation(cap,x=>x.integration.sharedScheduler=true),
    mutation(cap,x=>x.integration.jobSubmission=true)
  ]) assert.throws(()=>validateCapability(broken));
});

test('unknown properties including paths, account identifiers and tokens rejected',()=>{
  const cap=cases[0];
  for(const broken of [
    mutation(cap,x=>x.token='secret'),
    mutation(cap,x=>x.url='https://example.com'),
    mutation(cap,x=>x.snapshot.path='C:\\Users\\Chris'),
    mutation(cap,x=>x.policy.userApproval='assumed'),
    mutation(cap,x=>x.result.metadata={})
  ]) {
    assert.throws(()=>validateCapability(broken));
    assert.equal(evaluateRequest(broken,'inspect_static_descriptor').decision,'DENY');
  }
});

test('absent, null or invalid JSON-shaped declaration denies all requests',()=>{
  for(const value of [null,[],{},'x',new Date(),Object.create(null)]) {
    assert.equal(evaluateRequest(value,'inspect_static_descriptor').decision,'DENY');
  }
});

test('JSON Schema and validator agree on the locked fixture structure',()=>{
  const schema=JSON.parse(readFileSync(join(root,'capability.schema.json'),'utf8'));
  assert.equal(schema.additionalProperties,false);
  for(const cap of cases){
    assert.deepEqual(Object.keys(cap).sort(),schema.required.slice().sort());
    assert.equal(cap.schemaVersion,schema.properties.schemaVersion.const);
    assert.ok(schema.properties.projectId.enum.includes(cap.projectId));
    assert.ok(schema.properties.repository.enum.includes(cap.repository));
    for(const [section,properties] of [['snapshot',cap.snapshot],['policy',cap.policy],['gpu',cap.gpu],['result',cap.result],['integration',cap.integration]]){
      assert.equal(schema.properties[section].additionalProperties,false);
      assert.deepEqual(Object.keys(properties).sort(),schema.properties[section].required.slice().sort());
      for(const [key,value] of Object.entries(properties)){
        const rule=schema.properties[section].properties[key];
        if(Object.hasOwn(rule,'const')) assert.equal(value,rule.const);
      }
    }
  }
});
