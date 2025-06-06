import { Uri, window, workspace, commands } from 'vscode';
import * as sinon from 'sinon';
import {
    assertGroups,
    cleanupFossil,
    fakeExecutionResult,
    fakeFossilStatus,
    fakeUpdateResult,
    getExecStub,
    getRepository,
} from './common';
import * as assert from 'assert/strict';
import * as fs from 'fs/promises';
import {
    FossilCheckin,
    FossilCommitMessage,
    FossilRemoteName,
    OpenedRepository,
    RelativePath,
    ResourceStatus,
    StashID,
} from '../../openedRepository';
import { Suite, after, before } from 'mocha';
import { Reason } from '../../fossilExecutable';

function PullAndPushSuite(this: Suite): void {
    const noRemotes = async (
        command: 'fossil.pull' | 'fossil.push' | 'fossil.pushTo'
    ) => {
        const execStub = getExecStub(this.ctx.sandbox);
        const listCall = execStub
            .withArgs(['remote', 'list'])
            .resolves(fakeExecutionResult({ stdout: '' }));
        const sem = this.ctx.sandbox
            .stub(window, 'showErrorMessage')
            .resolves() as sinon.SinonStub;
        await commands.executeCommand(command);
        sinon.assert.calledOnce(listCall);
        sinon.assert.calledOnceWithExactly(
            sem,
            'Your repository has no remotes configured.'
        );
    };

    test('Pull no remotes', async () => {
        await noRemotes('fossil.pull');
    });

    test('Push no remotes', async () => {
        await noRemotes('fossil.push');
    });

    test('PushTo no remotes', async () => {
        await noRemotes('fossil.pushTo');
    });

    before(() => {
        const repository = getRepository();
        assert.equal((repository.queue as any)._items.length, 0);
    });

    test('Pull', async () => {
        const execStub = getExecStub(this.ctx.sandbox);
        const listCall = execStub
            .withArgs(['remote', 'list'])
            .resolves(
                fakeExecutionResult({ stdout: 'default https://example.com\n' })
            );
        const sem = this.ctx.sandbox
            .stub(window, 'showErrorMessage')
            .resolves();
        const pullCall = execStub
            .withArgs(sinon.match.array.startsWith(['pull']))
            .resolves();
        await commands.executeCommand('fossil.pull');
        sinon.assert.calledOnce(listCall);
        sinon.assert.notCalled(sem);
        sinon.assert.calledOnceWithExactly(pullCall, [
            'pull',
            'default' as FossilRemoteName,
        ]);
    });

    test('Update', async () => {
        const execStub = getExecStub(this.ctx.sandbox);
        const updateCall = execStub
            .withArgs(['update'])
            .resolves(fakeUpdateResult());

        await commands.executeCommand('fossil.update');
        sinon.assert.calledOnce(updateCall);
    });

    const oneRemote = async (command: 'fossil.push' | 'fossil.pushTo') => {
        const execStub = getExecStub(this.ctx.sandbox);
        const listCall = execStub
            .withArgs(['remote', 'list'])
            .resolves(
                fakeExecutionResult({ stdout: 'default https://example.com\n' })
            );
        const pushCall = execStub
            .withArgs(sinon.match.array.startsWith(['push']))
            .resolves();
        await commands.executeCommand(command);
        sinon.assert.calledOnce(listCall);
        return pushCall;
    };

    test('Push', async () => {
        const pushCall = await oneRemote('fossil.push');
        sinon.assert.calledOnceWithExactly(pushCall, ['push']);
    });

    test('PushTo (one remote)', async () => {
        const pushCall = await oneRemote('fossil.pushTo');
        sinon.assert.calledOnceWithExactly(pushCall, [
            'push',
            'default' as FossilRemoteName,
        ]);
    });

    test('PushTo (two remotes)', async () => {
        const execStub = getExecStub(this.ctx.sandbox);
        const listCall = execStub.withArgs(['remote', 'list']).resolves(
            fakeExecutionResult({
                stdout: 'default https://example.com\norigin ssh://fossil\n',
            })
        );
        const sqp = this.ctx.sandbox.stub(window, 'showQuickPick');
        sqp.onFirstCall().callsFake(items => {
            assert.ok(items instanceof Array);
            assert.equal(items.length, 2);
            assert.equal(items[1].label, '$(link) origin');
            assert.equal(items[1].detail, 'ssh://fossil');
            return Promise.resolve(items[1]);
        });

        const pushCall = execStub
            .withArgs(sinon.match.array.startsWith(['push']))
            .resolves();
        await commands.executeCommand('fossil.pushTo');
        sinon.assert.calledOnce(listCall);
        sinon.assert.calledOnce(sqp);
        sinon.assert.calledOnceWithExactly(pushCall, [
            'push',
            'origin' as FossilRemoteName,
        ]);
    });

    test('PushTo (two remotes, do not pick)', async () => {
        const execStub = getExecStub(this.ctx.sandbox);
        const listCall = execStub.withArgs(['remote', 'list']).resolves(
            fakeExecutionResult({
                stdout: 'default https://example.com\norigin ssh://fossil\n',
            })
        );
        const sqp = this.ctx.sandbox.stub(window, 'showQuickPick');
        sqp.onFirstCall().callsFake(items => {
            assert.ok(items instanceof Array);
            assert.equal(items.length, 2);
            assert.equal(items[1].label, '$(link) origin');
            assert.equal(items[1].detail, 'ssh://fossil');
            return Promise.resolve(undefined);
        });

        const pushCall = execStub
            .withArgs(sinon.match.array.startsWith(['push']))
            .resolves();
        await commands.executeCommand('fossil.pushTo');
        sinon.assert.calledOnce(listCall);
        sinon.assert.calledOnce(sqp);
        sinon.assert.notCalled(pushCall);
    });
}

export function UpdateSuite(this: Suite): void {
    suite('Pull and Push', PullAndPushSuite);

    test('Change branch to trunk', async () => {
        const execStub = getExecStub(this.ctx.sandbox);
        const updateCall = execStub
            .withArgs(['update', 'trunk' as FossilCheckin])
            .resolves(fakeUpdateResult());

        const sqp = this.ctx.sandbox.stub(window, 'showQuickPick');
        sqp.onFirstCall().callsFake(items => {
            assert.ok(items instanceof Array);
            assert.equal(items[2].label, '$(git-branch) trunk');
            assert.equal(items[2].description, 'current');
            assert.equal(items[2].detail, undefined);
            return Promise.resolve(items[2]);
        });

        await commands.executeCommand('fossil.branchChange');
        sinon.assert.calledOnce(sqp);
        sinon.assert.calledOnce(updateCall);
    });

    const selectTrunk = async () => {
        const execStub = getExecStub(this.ctx.sandbox);
        fakeFossilStatus(execStub, 'ADDED fake.txt\nCHERRYPICK aaa');
        const repository = getRepository();
        await repository.updateStatus('Test' as Reason);
        assert.ok(repository.fossilStatus?.isMerge);

        const updateCall = execStub
            .withArgs(['update', 'trunk' as FossilCheckin])
            .resolves(fakeUpdateResult());

        const showQuickPick = this.ctx.sandbox.stub(window, 'showQuickPick');
        showQuickPick.onFirstCall().callsFake(items => {
            assert.ok(items instanceof Array);
            assert.equal(items[2].label, '$(git-branch) trunk');
            return Promise.resolve(items[2]);
        });

        const swm: sinon.SinonStub = this.ctx.sandbox.stub(
            window,
            'showWarningMessage'
        );
        return [swm, updateCall];
    };

    test('Change branch to trunk when merge is active', async () => {
        const [swm, updateCall] = await selectTrunk();
        swm.resolves('Continue' as any);
        await commands.executeCommand('fossil.branchChange');
        sinon.assert.calledOnce(swm);
        sinon.assert.calledOnce(updateCall);
    });

    test('Change branch to trunk when merge is active (cancel)', async () => {
        const [swm, updateCall] = await selectTrunk();
        swm.resolves();
        await commands.executeCommand('fossil.branchChange');
        sinon.assert.calledOnce(swm);
        sinon.assert.notCalled(updateCall);
    });

    test('Change branch to hash', async () => {
        await cleanupFossil(getRepository());
        const execStub = getExecStub(this.ctx.sandbox);
        const updateCall = execStub
            .withArgs(['update', '1234567890' as FossilCheckin])
            .resolves(fakeUpdateResult());

        const showQuickPick = this.ctx.sandbox.stub(window, 'showQuickPick');
        showQuickPick.onFirstCall().callsFake(items => {
            assert.ok(items instanceof Array);
            assert.equal(items[0].label, '$(pencil) Checkout by hash');
            assert.equal(items[0].description, undefined);
            assert.equal(items[0].detail, undefined);
            return Promise.resolve(items[0]);
        });
        const showInputBox = this.ctx.sandbox.stub(window, 'showInputBox');
        showInputBox.onFirstCall().resolves('1234567890');
        await commands.executeCommand('fossil.branchChange');

        sinon.assert.calledOnce(showInputBox);
        sinon.assert.calledOnce(updateCall);
    });

    test('Change branch to hash (cancel)', async () => {
        const showQuickPick = this.ctx.sandbox.stub(window, 'showQuickPick');
        showQuickPick.onFirstCall().callsFake(items => {
            assert.ok(items instanceof Array);
            assert.equal(items[0].label, '$(pencil) Checkout by hash');
            return Promise.resolve(items[0]);
        });
        const showInputBox = this.ctx.sandbox.stub(window, 'showInputBox');
        showInputBox.onFirstCall().resolves();
        await commands.executeCommand('fossil.branchChange');
        sinon.assert.calledOnce(showInputBox);
    });

    test('Change branch to tag', async () => {
        const showQuickPick = this.ctx.sandbox.stub(window, 'showQuickPick');

        const execStub = getExecStub(this.ctx.sandbox);
        const tagsStub = execStub
            .withArgs(['tag', 'list'])
            .resolves(fakeExecutionResult({ stdout: 'a\nb $(plus)\nc c c' }));
        const branchesStub = execStub
            .withArgs(sinon.match.array.startsWith(['branch', 'ls']))
            .resolves(
                fakeExecutionResult({ stdout: '   d\n   e $(plus)\n   f f f' })
            );

        showQuickPick.onFirstCall().callsFake(items => {
            assert.ok(items instanceof Array);
            assert.equal(items[0].label, '$(pencil) Checkout by hash');
            assert.equal(items[1].label, '');
            assert.equal(items[2].label, '$(git-branch) d');
            assert.equal(items[3].label, '$(git-branch) e $(plus)');
            assert.equal(items[4].label, '$(git-branch) f f f');
            assert.equal(items[5].label, '$(tag) a');
            assert.equal(items[6].label, '$(tag) b $(plus)');
            assert.equal(items[7].label, '$(tag) c c c');
            return Promise.resolve(items[5]);
        });
        const updateCall = execStub
            .withArgs(['update', 'a' as FossilCheckin])
            .resolves(fakeUpdateResult());
        await commands.executeCommand('fossil.branchChange');
        sinon.assert.calledOnce(tagsStub);
        sinon.assert.calledOnce(branchesStub);
        sinon.assert.calledOnce(showQuickPick);
        sinon.assert.calledOnce(updateCall);
    });
}

export function StashSuite(this: Suite): void {
    let uri: Uri;
    /**
     * Create a file and stash it
     */
    before(() => {
        uri = Uri.joinPath(workspace.workspaceFolders![0].uri, 'stash.txt');
    });

    test('Save', async () => {
        const repository = getRepository();
        await fs.writeFile(uri.fsPath, 'stash me');

        const sib = this.ctx.sandbox.stub(window, 'showInputBox');
        sib.onFirstCall().resolves('stashSave commit message');

        const stashSave = getExecStub(this.ctx.sandbox).withArgs([
            'stash',
            'save',
            '-m',
            'stashSave commit message',
            'stash.txt',
        ]);
        await repository.updateStatus('Test' as Reason);
        const resource = repository.untrackedGroup.getResource(uri);
        assert.ok(resource);
        await commands.executeCommand('fossil.add', resource);
        await commands.executeCommand('fossil.stashSave');
        sinon.assert.calledOnce(stashSave);
        assertGroups(repository, {
            untracked: [[uri.fsPath, ResourceStatus.EXTRA]],
        });
    }).timeout(6000);

    /**
     * Apply previously stashed item, while keeping it in the list
     */
    test('Apply', async () => {
        const execStub = getExecStub(this.ctx.sandbox);
        const stashApply = execStub.withArgs([
            'stash',
            'apply',
            `${1 as StashID}`,
        ]);
        const sqp = this.ctx.sandbox.stub(window, 'showQuickPick');
        sqp.onFirstCall().callsFake(items => {
            assert.ok(items instanceof Array);
            assert.equal(items.length, 1);
            assert.match(
                items[0].label,
                /\$\(circle-outline\) 1 • [a-f0-9]{12}/
            );
            return Promise.resolve(items[0]);
        });
        await commands.executeCommand('fossil.stashApply');
        sinon.assert.calledOnce(stashApply);
        const repository = getRepository();
        assertGroups(repository, {
            working: [[uri.fsPath, ResourceStatus.ADDED]],
        });
    }).timeout(6000);

    /**
     * Remove previously created stash from the list
     */
    test('Drop', async () => {
        const execStub = getExecStub(this.ctx.sandbox);
        const stashApply = execStub.withArgs([
            'stash',
            'drop',
            `${1 as StashID}`,
        ]);
        const sqp = this.ctx.sandbox.stub(window, 'showQuickPick');
        sqp.onFirstCall().callsFake(items => {
            assert.ok(items instanceof Array);
            assert.equal(items.length, 1);
            assert.match(
                items[0].label,
                /\$\(circle-outline\) 1 • [a-f0-9]{12}/
            );
            assert.equal(items[0].description, '$(calendar) now');
            assert.equal(items[0].detail, 'stashSave commit message');
            return Promise.resolve(items[0]);
        });
        await commands.executeCommand('fossil.stashDrop');
        sinon.assert.calledOnce(stashApply);
        sinon.assert.calledOnce(sqp);

        const repository = getRepository();
        assertGroups(repository, {
            working: [[uri.fsPath, ResourceStatus.ADDED]],
        });
    }).timeout(6000);

    /**
     * Stash a file ant then pop this stash
     */
    test('Pop', async () => {
        const execStub = getExecStub(this.ctx.sandbox);
        const repository = getRepository();
        const openedRepository: OpenedRepository = (repository as any)
            .repository;
        await openedRepository.exec([
            'stash',
            'save',
            '-m',
            'in test' as FossilCommitMessage,
            'stash.txt' as RelativePath,
        ]);
        const stashPop = execStub.withArgs(['stash', 'pop']);
        await commands.executeCommand('fossil.stashPop');
        sinon.assert.calledOnce(stashPop);
        assertGroups(repository, {
            working: [[uri.fsPath, ResourceStatus.ADDED]],
        });
    }).timeout(15000);

    test('Snapshot', async () => {
        const repository = getRepository();
        assertGroups(repository, {
            working: [[uri.fsPath, ResourceStatus.ADDED]],
        });
        const execStub = getExecStub(this.ctx.sandbox);
        const stashSnapshot = execStub.withArgs([
            'stash',
            'snapshot',
            '-m',
            'stashSnapshot commit message',
            'stash.txt',
        ]);
        const sib = this.ctx.sandbox
            .stub(window, 'showInputBox')
            .resolves('stashSnapshot commit message');

        const swm: sinon.SinonStub = this.ctx.sandbox.stub(
            window,
            'showWarningMessage'
        );
        swm.withArgs(
            'There are no staged changes, do you want to commit working changes?\n'
        ).resolves('C&&onfirm');

        await commands.executeCommand('fossil.stashSnapshot');
        sinon.assert.calledOnce(sib);
        sinon.assert.calledOnce(swm);
        sinon.assert.calledOnce(stashSnapshot);
    }).timeout(15000);

    after(async () => {
        await cleanupFossil(getRepository());
    });
}

export function PatchSuite(this: Suite): void {
    test('Create', async () => {
        const patchPath = Uri.file('patch.patch');
        const showSaveDialogstub = this.ctx.sandbox
            .stub(window, 'showSaveDialog')
            .resolves(patchPath);

        const patchStub = getExecStub(this.ctx.sandbox)
            .withArgs(['patch', 'create', patchPath.fsPath])
            .resolves();
        await commands.executeCommand('fossil.patchCreate');
        sinon.assert.calledOnceWithMatch(showSaveDialogstub, {
            saveLabel: 'Create',
            title: 'Create binary patch',
        });
        sinon.assert.calledOnce(patchStub);
    });

    test('Apply', async () => {
        const patchPath = Uri.file('patch.patch');
        const showOpenDialogstub = this.ctx.sandbox
            .stub(window, 'showOpenDialog')
            .resolves([patchPath]);

        const patchStub = getExecStub(this.ctx.sandbox)
            .withArgs(['patch', 'apply', patchPath.fsPath])
            .resolves();
        await commands.executeCommand('fossil.patchApply');
        sinon.assert.calledOnceWithMatch(showOpenDialogstub, {
            openLabel: 'Apply',
            title: 'Apply binary patch',
        });
        sinon.assert.calledOnce(patchStub);
    });
}

export function StageSuite(this: Suite): void {
    let a_txt: string;
    let b_txt: string;
    let c_txt: string;

    before(async () => {
        await cleanupFossil(getRepository());
        const rootUri = workspace.workspaceFolders![0].uri;
        a_txt = Uri.joinPath(rootUri, 'a.txt').fsPath;
        b_txt = Uri.joinPath(rootUri, 'b.txt').fsPath;
        c_txt = Uri.joinPath(rootUri, 'c.txt').fsPath;
    });

    const statusSetup = async (status: string) => {
        const execStub = getExecStub(this.ctx.sandbox);
        fakeFossilStatus(execStub, status);
        const repository = getRepository();
        await repository.updateStatus('Test' as Reason);
    };

    test('Stage from working group', async () => {
        await commands.executeCommand('fossil.unstageAll');
        await statusSetup('ADDED a.txt\nEDITED b.txt\nEDITED c.txt');
        const repository = getRepository();
        assertGroups(repository, {
            working: [
                [a_txt, ResourceStatus.ADDED],
                [b_txt, ResourceStatus.MODIFIED],
                [c_txt, ResourceStatus.MODIFIED],
            ],
        });
        await commands.executeCommand(
            'fossil.stage',
            repository.workingGroup.resourceStates[0],
            repository.workingGroup.resourceStates[1]
        );
        assertGroups(repository, {
            working: [[c_txt, ResourceStatus.MODIFIED]],
            staging: [
                [a_txt, ResourceStatus.ADDED],
                [b_txt, ResourceStatus.MODIFIED],
            ],
        });
    });

    test('Stage (nothing)', async () => {
        await commands.executeCommand('fossil.stage');
    });

    test('Unstage (nothing)', async () => {
        await commands.executeCommand('fossil.unstage');
    });

    test('Stage all / Unstage all', async () => {
        await commands.executeCommand('fossil.unstageAll');
        await statusSetup('ADDED a.txt\nEDITED b.txt\nEDITED c.txt');
        const repository = getRepository();
        const allStatuses = [
            [a_txt, ResourceStatus.ADDED] as const,
            [b_txt, ResourceStatus.MODIFIED] as const,
            [c_txt, ResourceStatus.MODIFIED] as const,
        ];
        assertGroups(repository, { working: allStatuses });
        await commands.executeCommand('fossil.stageAll');
        assertGroups(repository, { staging: allStatuses });
        await commands.executeCommand('fossil.unstageAll');
        assertGroups(repository, { working: allStatuses });
    });

    test('Unstage', async () => {
        const repository = getRepository();
        await statusSetup('ADDED a.txt\nEDITED b.txt\nEDITED c.txt');
        const allStatuses = [
            [a_txt, ResourceStatus.ADDED] as const,
            [b_txt, ResourceStatus.MODIFIED] as const,
            [c_txt, ResourceStatus.MODIFIED] as const,
        ];
        assertGroups(repository, { working: allStatuses });
        await commands.executeCommand('fossil.stageAll');
        assertGroups(repository, { staging: allStatuses });
        await commands.executeCommand(
            'fossil.unstage',
            repository.stagingGroup.resourceStates[1]
        );
        assertGroups(repository, {
            working: [[b_txt, ResourceStatus.MODIFIED]],
            staging: [
                [a_txt, ResourceStatus.ADDED],
                [c_txt, ResourceStatus.MODIFIED],
            ],
        });
    });
}
