import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'fs-extra';

async function main(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'eterx-chat-recovery-'));
  const dataRoot = path.join(root, 'data');
  const workspaceRoot = path.join(root, 'workspace');
  process.env.ETERX_DATA_DIR = dataRoot;
  process.env.ETERX_WORKSPACE_ROOT = workspaceRoot;

  try {
    await fs.ensureDir(path.join(dataRoot, 'chats'));
  await fs.writeJson(path.join(dataRoot, 'chats', 'chats.json'), {
    version: 1,
    savedAt: 1,
    chats: [],
  });

  // These modules resolve their durable roots at import time, after the test
  // has isolated them from the user's real application data.
  const [{ ContextFabric }, { saveChatSnapshot }, { stableScopeSegment }] = await Promise.all([
    import('../src/lib/agent/context-fabric'),
    import('../src/lib/chat-store'),
    import('../src/lib/agent/context-scope'),
  ]);

  const firstChatId = 'recovery-terminal-gap';
  const firstRunId = 'run-terminal-gap';
  const exactRequest = `Continue the existing task with the exact marker request_${'x'.repeat(2_200)}.`;
  const exactAnswer = `Recovered exact terminal answer answer_${'y'.repeat(4_500)}.`;
  const firstFabric = new ContextFabric(firstChatId);
  await firstFabric.initialize();
  firstFabric.observeUserRequest(exactRequest, 'continuation', firstRunId);
  firstFabric.recordAssistantResponse(exactAnswer, 'completed', firstRunId);
  await firstFabric.flush();

  const firstStored = await saveChatSnapshot([{
    id: firstChatId,
    title: 'Recovery terminal gap',
    updatedAt: 10,
    traceLogs: [
      {
        id: `user-turn-${firstRunId}`,
        type: 'user_action',
        text: exactRequest,
        runId: firstRunId,
        turnId: firstRunId,
        timestamp: 10,
      },
      {
        id: `run-terminal:${firstRunId}:${firstRunId}:done`,
        type: 'done',
        status: 'completed',
        mainTurnTerminal: true,
        runId: firstRunId,
        turnId: firstRunId,
        timestamp: 20,
      },
    ],
  }], 100);
  const firstChat = (firstStored.chats as any[]).find(chat => chat.id === firstChatId);
  const recoveredAnswers = firstChat.traceLogs.filter((log: any) => log.type === 'answer');
  assert.equal(recoveredAnswers.length, 1, 'a missing terminal answer should be reconstructed exactly once');
  assert.equal(recoveredAnswers[0].text, exactAnswer);
  assert.equal(recoveredAnswers[0].runId, firstRunId);
  assert.equal(recoveredAnswers[0]._recoveredExactText, true);

  const secondChatId = 'recovery-whole-turn-gap';
  const secondRunId = 'run-whole-turn-gap';
  const secondRequest = 'A continuation request whose whole optimistic snapshot was lost.';
  const secondAnswer = 'The whole turn was restored from the append-only context journal.';
  const secondFabric = new ContextFabric(secondChatId);
  await secondFabric.initialize();
  secondFabric.observeUserRequest(secondRequest, 'continuation', secondRunId);
  secondFabric.recordAssistantResponse(secondAnswer, 'completed', secondRunId);
  await secondFabric.flush();

  const secondStored = await saveChatSnapshot([
    firstChat,
    {
      id: secondChatId,
      title: 'Recovery whole turn gap',
      updatedAt: 30,
      traceLogs: [],
    },
  ], 200);
  const secondChat = (secondStored.chats as any[]).find(chat => chat.id === secondChatId);
  assert.deepEqual(
    secondChat.traceLogs.filter((log: any) => ['user_action', 'answer'].includes(log.type)).map((log: any) => log.text),
    [secondRequest, secondAnswer],
    'continuation episodes should rebuild a wholly missing visible turn in order',
  );

  const corruptChatId = 'recovery-corrupt-page';
  const corruptRunId = 'run-corrupt-page';
  const corruptFabric = new ContextFabric(corruptChatId);
  await corruptFabric.initialize();
  corruptFabric.observeUserRequest('Do not accept a bounded preview as exact transcript text.', 'continuation', corruptRunId);
  corruptFabric.recordAssistantResponse(`never-recover-preview-${'z'.repeat(3_000)}`, 'completed', corruptRunId);
  await corruptFabric.flush();
  const responseEpisode = corruptFabric.listEpisodes().find(episode =>
    episode.originId === `assistant-run:${corruptRunId}`,
  );
  assert.ok(responseEpisode);
  await fs.writeFile(
    path.join(workspaceRoot, '.context', 'fabric', stableScopeSegment(corruptChatId), responseEpisode!.pageRef),
    Buffer.from('corrupt context page'),
  );

  const corruptStored = await saveChatSnapshot([
    firstChat,
    secondChat,
    {
      id: corruptChatId,
      title: 'Recovery corrupt page',
      updatedAt: 40,
      traceLogs: [{
        id: `user-turn-${corruptRunId}`,
        type: 'user_action',
        text: 'Do not accept a bounded preview as exact transcript text.',
        runId: corruptRunId,
        turnId: corruptRunId,
        timestamp: 40,
      }, {
        id: `run-terminal:${corruptRunId}:${corruptRunId}:done`,
        type: 'done',
        status: 'completed',
        mainTurnTerminal: true,
        runId: corruptRunId,
        turnId: corruptRunId,
        timestamp: 50,
      }],
    },
  ], 300);
  const corruptChat = (corruptStored.chats as any[]).find(chat => chat.id === corruptChatId);
  assert.equal(
    corruptChat.traceLogs.some((log: any) => log.type === 'answer'),
    false,
    'a corrupt exact page must not fall back to its bounded preview',
  );

    console.log('Chat store exact recovery integration checks passed.');
  } finally {
    await fs.remove(root);
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
