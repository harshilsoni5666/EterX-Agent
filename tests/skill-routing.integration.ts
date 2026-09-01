import assert from 'node:assert/strict';
import { evaluateSkillLoad, getRelevantSkillIds } from '../src/lib/agent/skills-new/routing';

function testOrdinaryWorkDoesNotLoadSkills(): void {
  const requests = [
    'Fix the login bug in src/app/page.tsx and run the tests.',
    'Explain why this API handler returns 401.',
    'Refactor the graph traversal implementation.',
    'Hello, what can you do?',
  ];
  for (const request of requests) {
    assert.deepEqual(Array.from(getRelevantSkillIds(request)), [], request);
    assert.equal(evaluateSkillLoad(request, 'visualization', new Set()).allowed, false);
  }
}

function testExplicitArtifactRoutesOnePrimarySkill(): void {
  assert.deepEqual(Array.from(getRelevantSkillIds('Create a PowerPoint presentation with two charts.')), ['pptx']);
  assert.deepEqual(Array.from(getRelevantSkillIds('Make a presentation for the quarterly review.')), ['pptx']);
  assert.deepEqual(Array.from(getRelevantSkillIds('Build an Excel workbook with a dashboard chart.')), ['xlsx']);
  assert.deepEqual(Array.from(getRelevantSkillIds('Write this as a Word file.')), ['docx']);
  assert.deepEqual(Array.from(getRelevantSkillIds('Create a reusable template from this DOCX file.')), ['template_creator']);
  assert.deepEqual(Array.from(getRelevantSkillIds('Generate a new transparent-background product image.')), ['image_generation']);
  assert.deepEqual(Array.from(getRelevantSkillIds('Check this in HubSpot.')), ['connector_setup_and_mcp_operations']);
}

function testSkillSystemWorkRoutesSkillCreator(): void {
  const relevant = getRelevantSkillIds('Fix skill routing so prompts do not load skills repeatedly.');
  assert.deepEqual(Array.from(relevant), ['skill_creator']);
  assert.equal(evaluateSkillLoad('Fix skill routing.', 'skill-creator', new Set()).allowed, true);
  assert.equal(evaluateSkillLoad('Fix skill routing.', 'pdf', new Set()).allowed, false);
}

function testDedupIsTaskScoped(): void {
  const request = 'Create a PDF report.';
  const currentTask = new Set<string>();
  const first = evaluateSkillLoad(request, 'pdf', currentTask);
  assert.equal(first.allowed, true);
  currentTask.add(first.skillId);
  assert.equal(evaluateSkillLoad(request, 'pdf', currentTask).allowed, false);

  // A later task receives a fresh set and can use the same playbook again.
  assert.equal(evaluateSkillLoad('Edit this PDF.', 'pdf', new Set()).allowed, true);
}

testOrdinaryWorkDoesNotLoadSkills();
testExplicitArtifactRoutesOnePrimarySkill();
testSkillSystemWorkRoutesSkillCreator();
testDedupIsTaskScoped();
console.log('skill routing integration tests passed');
