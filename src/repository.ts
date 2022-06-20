import {
    Uri,
    Command,
    EventEmitter,
    Event,
    scm,
    SourceControl,
    SourceControlResourceState,
    SourceControlResourceDecorations,
    Disposable,
    ProgressLocation,
    window,
    workspace,
    commands,
} from 'vscode';
import {
    Repository as BaseRepository,
    Ref,
    Commit,
    FossilError,
    IRepoStatus,
    PullOptions,
    FossilErrorCodes,
    IMergeResult,
    CommitDetails,
    LogEntryRepositoryOptions,
    FossilUndoDetails,
    FossilRoot,
} from './fossilBase';
import {
    anyEvent,
    filterEvent,
    eventToPromise,
    dispose,
    IDisposable,
    delay,
    partition,
} from './util';
import { memoize, throttle, debounce } from './decorators';
import { StatusBarCommands } from './statusbar';
import typedConfig from './config';

import * as path from 'path';
import * as nls from 'vscode-nls';
import {
    FossilResourceGroup,
    createEmptyStatusGroups,
    IStatusGroups,
    groupStatuses,
    IGroupStatusesParams,
} from './resourceGroups';
import { Path } from './fossilBase';
import {
    AutoInOutState,
    AutoInOutStatuses,
    AutoIncomingOutgoing,
} from './autoinout';
import { interaction, PushCreatesNewHeadAction } from './interaction';
import { FossilUriParams, toFossilUri } from './uri';

const timeout = (millis: number) => new Promise(c => setTimeout(c, millis));

const localize = nls.loadMessageBundle();
const iconsRootPath = path.join(path.dirname(__dirname), 'resources', 'icons');

function getIconUri(iconName: string, theme: string): Uri {
    return Uri.file(path.join(iconsRootPath, theme, `${iconName}.svg`));
}

export interface LogEntriesOptions {
    revQuery?: string;
    file?: Uri;
    limit?: number;
}

export enum RepositoryState {
    Idle,
    Disposed,
}

export enum Status {
    MODIFIED,
    ADDED,
    DELETED,
    UNTRACKED,
    IGNORED,
    MISSING,
    RENAMED,
    UNMODIFIED,
    CONFLICT,
}

export enum MergeStatus {
    NONE,
    UNRESOLVED,
    RESOLVED,
}

export class FossilResource implements SourceControlResourceState {
    @memoize
    get command(): Command {
        return {
            command: 'fossil.openResource',
            title: localize('open', 'Open'),
            arguments: [this],
        };
    }

    get isDirtyStatus(): boolean {
        switch (this._status) {
            case Status.UNTRACKED:
            case Status.IGNORED:
                return false;

            case Status.ADDED:
            case Status.DELETED:
            case Status.MISSING:
            case Status.MODIFIED:
            case Status.RENAMED:
            case Status.CONFLICT:
            default:
                return true;
        }
    }

    get original(): Uri {
        return this._resourceUri;
    }
    get renameResourceUri(): Uri | undefined {
        return this._renameResourceUri;
    }
    @memoize
    get resourceUri(): Uri {
        if (this.renameResourceUri) {
            if (
                this._status === Status.MODIFIED ||
                this._status === Status.RENAMED ||
                this._status === Status.ADDED ||
                this._status === Status.CONFLICT
            ) {
                return this.renameResourceUri;
            }

            throw new Error(
                `Renamed resource with unexpected status: ${this._status}`
            );
        }
        return this._resourceUri;
    }
    get resourceGroup(): FossilResourceGroup {
        return this._resourceGroup;
    }
    get status(): Status {
        return this._status;
    }
    get mergeStatus(): MergeStatus {
        return this._mergeStatus;
    }

    private static Icons: { [key: string]: any } = {
        light: {
            Modified: getIconUri('status-modified', 'light'),
            Missing: getIconUri('status-missing', 'light'),
            Added: getIconUri('status-added', 'light'),
            Deleted: getIconUri('status-deleted', 'light'),
            Renamed: getIconUri('status-renamed', 'light'),
            // Copied: getIconUri('status-copied', 'light'),
            Untracked: getIconUri('status-untracked', 'light'),
            Ignored: getIconUri('status-ignored', 'light'),
            Conflict: getIconUri('status-conflict', 'light'),
            Unmodified: getIconUri('status-clean', 'light'),
        },
        dark: {
            Modified: getIconUri('status-modified', 'dark'),
            Missing: getIconUri('status-missing', 'dark'),
            Added: getIconUri('status-added', 'dark'),
            Deleted: getIconUri('status-deleted', 'dark'),
            Renamed: getIconUri('status-renamed', 'dark'),
            // Copied: getIconUri('status-copied', 'dark'),
            Untracked: getIconUri('status-untracked', 'dark'),
            Ignored: getIconUri('status-ignored', 'dark'),
            Conflict: getIconUri('status-conflict', 'dark'),
            Unmodified: getIconUri('status-clean', 'dark'),
        },
    };

    private getIconPath(theme: string): Uri | undefined {
        if (
            this.mergeStatus === MergeStatus.UNRESOLVED &&
            this.status !== Status.MISSING &&
            this.status !== Status.DELETED
        ) {
            return FossilResource.Icons[theme].Conflict;
        }

        switch (this.status) {
            case Status.MISSING:
                return FossilResource.Icons[theme].Missing;
            case Status.MODIFIED:
                return FossilResource.Icons[theme].Modified;
            case Status.ADDED:
                return FossilResource.Icons[theme].Added;
            case Status.DELETED:
                return FossilResource.Icons[theme].Deleted;
            case Status.RENAMED:
                return FossilResource.Icons[theme].Renamed;
            case Status.UNTRACKED:
                return FossilResource.Icons[theme].Untracked;
            case Status.IGNORED:
                return FossilResource.Icons[theme].Ignored;
            case Status.UNMODIFIED:
                return FossilResource.Icons[theme].Unmodified;
            case Status.CONFLICT:
                return FossilResource.Icons[theme].Conflict;
            default:
                return void 0;
        }
    }

    private get strikeThrough(): boolean {
        switch (this.status) {
            case Status.DELETED:
                return true;
            default:
                return false;
        }
    }

    get decorations(): SourceControlResourceDecorations {
        const light = { iconPath: this.getIconPath('light') };
        const dark = { iconPath: this.getIconPath('dark') };

        return { strikeThrough: this.strikeThrough, light, dark };
    }

    constructor(
        private _resourceGroup: FossilResourceGroup,
        private _resourceUri: Uri,
        private _status: Status,
        private _mergeStatus: MergeStatus,
        private _renameResourceUri?: Uri
    ) {}
}

export const enum Operation {
    Status = 1 << 0,
    Add = 1 << 1,
    RevertFiles = 1 << 2,
    Commit = 1 << 3,
    Clean = 1 << 4,
    Branch = 1 << 5,
    Update = 1 << 6,
    Undo = 1 << 7,
    UndoDryRun = 1 << 8,
    Pull = 1 << 9,
    Push = 1 << 10,
    Sync = 1 << 11,
    Init = 1 << 12,
    Show = 1 << 13,
    Stage = 1 << 14,
    GetCommitTemplate = 1 << 15,
    Revert = 1 << 16,
    Resolve = 1 << 17,
    Unresolve = 1 << 18,
    Parents = 1 << 19,
    Remove = 1 << 20,
    Merge = 1 << 21,
    Close = 1 << 25,
    Ignore = 1 << 26,
}

function isReadOnly(operation: Operation): boolean {
    switch (operation) {
        case Operation.Show:
        case Operation.GetCommitTemplate:
            return true;
        default:
            return false;
    }
}

interface Operations {
    isIdle(): boolean;
    isRunning(operation: Operation): boolean;
}

class OperationsImpl implements Operations {
    constructor(private readonly operations: number = 0) {
        // noop
    }

    start(operation: Operation): OperationsImpl {
        return new OperationsImpl(this.operations | operation);
    }

    end(operation: Operation): OperationsImpl {
        return new OperationsImpl(this.operations & ~operation);
    }

    isRunning(operation: Operation): boolean {
        return (this.operations & operation) !== 0;
    }

    isIdle(): boolean {
        return this.operations === 0;
    }
}

export const enum CommitScope {
    ALL,
    STAGED_CHANGES,
    CHANGES,
}

export interface CommitOptions {
    scope: CommitScope;
}

export class Repository implements IDisposable {
    private _onDidChangeRepository = new EventEmitter<Uri>();
    readonly onDidChangeRepository: Event<Uri> =
        this._onDidChangeRepository.event;

    private _onDidChangeState = new EventEmitter<RepositoryState>();
    readonly onDidChangeState: Event<RepositoryState> =
        this._onDidChangeState.event;

    private _onDidChangeStatus = new EventEmitter<void>();
    readonly onDidChangeStatus: Event<void> = this._onDidChangeStatus.event;

    private _onDidChangeInOutState = new EventEmitter<void>();
    readonly onDidChangeInOutState: Event<void> =
        this._onDidChangeInOutState.event;

    private _onDidChangeResources = new EventEmitter<void>();
    readonly onDidChangeResources: Event<void> =
        this._onDidChangeResources.event;

    @memoize
    get onDidChange(): Event<void> {
        return anyEvent<any>(
            this.onDidChangeState,
            this.onDidChangeResources,
            this.onDidChangeInOutState
        );
    }

    private _onDidChangeOriginalResource = new EventEmitter<Uri>();
    readonly onDidChangeOriginalResource: Event<Uri> =
        this._onDidChangeOriginalResource.event;

    private _onRunOperation = new EventEmitter<Operation>();
    readonly onRunOperation: Event<Operation> = this._onRunOperation.event;

    private _onDidRunOperation = new EventEmitter<Operation>();
    readonly onDidRunOperation: Event<Operation> =
        this._onDidRunOperation.event;

    private _sourceControl: SourceControl;

    get sourceControl(): SourceControl {
        return this._sourceControl;
    }

    @memoize
    get onDidChangeOperations(): Event<void> {
        return anyEvent(
            this.onRunOperation as Event<any>,
            this.onDidRunOperation as Event<any>
        );
    }

    // ToDo: remove. nobody uses `lastPushPath`
    private _lastPushPath: string | undefined;
    get lastPushPath(): string | undefined {
        return this._lastPushPath;
    }

    private _groups: IStatusGroups;
    get mergeGroup(): FossilResourceGroup {
        return this._groups.merge;
    }
    get conflictGroup(): FossilResourceGroup {
        return this._groups.conflict;
    }
    get stagingGroup(): FossilResourceGroup {
        return this._groups.staging;
    }
    get workingDirectoryGroup(): FossilResourceGroup {
        return this._groups.working;
    }
    get untrackedGroup(): FossilResourceGroup {
        return this._groups.untracked;
    }

    private _currentBranch: Ref | undefined;
    get currentBranch(): Ref | undefined {
        return this._currentBranch;
    }

    private _repoStatus: IRepoStatus | undefined;
    get repoStatus(): IRepoStatus | undefined {
        return this._repoStatus;
    }

    private _refs: Ref[] = [];
    get refs(): Ref[] {
        return this._refs;
    }

    private _path!: Path;
    get path(): Path {
        return this._path;
    }

    private _operations = new OperationsImpl();
    get operations(): Operations {
        return this._operations;
    }

    private _autoInOutState: AutoInOutState = {
        status: AutoInOutStatuses.Disabled,
    };
    get autoInOutState(): AutoInOutState {
        return this._autoInOutState;
    }

    public changeAutoInoutState(state: Partial<AutoInOutState>): void {
        this._autoInOutState = {
            ...this._autoInOutState,
            ...state,
        };
        this._onDidChangeInOutState.fire();
    }

    get repoName(): string {
        return path.basename(this.repository.root);
    }

    get isClean(): boolean {
        const groups = [
            this.workingDirectoryGroup,
            this.mergeGroup,
            this.conflictGroup,
            this.stagingGroup,
        ];
        return groups.every(g => g.resourceStates.length === 0);
    }

    toUri(rawPath: string): Uri {
        return Uri.file(path.join(this.repository.root, rawPath));
    }

    private _state = RepositoryState.Idle;
    get state(): RepositoryState {
        return this._state;
    }
    set state(state: RepositoryState) {
        this._state = state;
        this._onDidChangeState.fire(state);

        this._currentBranch = undefined;
        this._refs = [];
        this._groups.conflict.updateResources([]);
        this._groups.merge.updateResources([]);
        this._groups.staging.updateResources([]);
        this._groups.untracked.updateResources([]);
        this._groups.working.updateResources([]);
        this._onDidChangeResources.fire();
    }

    get root(): FossilRoot {
        return this.repository.root;
    }

    private disposables: Disposable[] = [];

    constructor(private readonly repository: BaseRepository) {
        this.updateRepositoryPaths();

        const fsWatcher = workspace.createFileSystemWatcher('**');
        this.disposables.push(fsWatcher);

        const onWorkspaceChange = anyEvent(
            fsWatcher.onDidChange,
            fsWatcher.onDidCreate,
            fsWatcher.onDidDelete
        );
        const onRepositoryChange = filterEvent(
            onWorkspaceChange,
            uri => !/^\.\./.test(path.relative(repository.root, uri.fsPath))
        );
        const onRelevantRepositoryChange = filterEvent(
            onRepositoryChange,
            uri => !/\/\.hg\/(\w?lock.*|.*\.log([-.]\w+)?)$/.test(uri.path)
        );
        onRelevantRepositoryChange(this.onFSChange, this, this.disposables);

        const onRelevantHgChange = filterEvent(
            onRelevantRepositoryChange,
            uri => /\/\.hg\//.test(uri.path)
        );
        onRelevantHgChange(
            this._onDidChangeRepository.fire,
            this._onDidChangeRepository,
            this.disposables
        );

        this._sourceControl = scm.createSourceControl(
            'fossil',
            'Fossil',
            Uri.file(repository.root)
        );
        this.disposables.push(this._sourceControl);

        this._sourceControl.acceptInputCommand = {
            command: 'fossil.commitWithInput',
            title: localize('commit', 'Commit'),
        };
        this._sourceControl.quickDiffProvider = this;

        const groups = createEmptyStatusGroups(this._sourceControl);

        this.disposables.push(new AutoIncomingOutgoing(this));

        this._groups = groups;
        this.disposables.push(
            ...Object.values(groups).map(
                (group: FossilResourceGroup) => group.disposable
            )
        );

        const statusBar = new StatusBarCommands(this);
        this.disposables.push(statusBar);
        statusBar.onDidChange(
            () => {
                this._sourceControl.statusBarCommands = statusBar.commands;
            },
            null,
            this.disposables
        );
        this._sourceControl.statusBarCommands = statusBar.commands;

        this.status();
    }

    provideOriginalResource(uri: Uri): Uri | undefined {
        if (uri.scheme !== 'file') {
            return;
        }
        return toFossilUri(uri);
    }

    @throttle
    async status(): Promise<void> {
        await this.run(Operation.Status);
    }

    private onFSChange(_uri: Uri): void {
        if (!typedConfig.autoRefresh) {
            return;
        }

        if (!this.operations.isIdle()) {
            return;
        }

        this.eventuallyUpdateWhenIdleAndWait();
    }

    @debounce(1000)
    private eventuallyUpdateWhenIdleAndWait(): void {
        this.updateWhenIdleAndWait();
    }

    @throttle
    private async updateWhenIdleAndWait(): Promise<void> {
        await this.whenIdleAndFocused();
        await this.status();
        await timeout(5000);
    }

    async whenIdleAndFocused(): Promise<void> {
        while (true) {
            if (!this.operations.isIdle()) {
                await eventToPromise(this.onDidRunOperation);
                continue;
            }

            if (!window.state.focused) {
                const onDidFocusWindow = filterEvent(
                    window.onDidChangeWindowState,
                    e => e.focused
                );
                await eventToPromise(onDidFocusWindow);
                continue;
            }

            return;
        }
    }

    @throttle
    async add(...uris: Uri[]): Promise<void> {
        let resources: FossilResource[];
        if (uris.length === 0) {
            resources = this._groups.untracked.resourceStates;
        } else {
            resources = this.mapResources(uris);
        }
        const relativePaths: string[] = resources.map(r =>
            this.mapResourceToRepoRelativePath(r)
        );
        await this.run(Operation.Add, () => this.repository.add(relativePaths));
    }
    async ls(...uris: Uri[]): Promise<Uri[]> {
        const lsResult = await this.repository.ls(uris.map(url => url.fsPath));
        const rootUri = Uri.file(this.root);
        return lsResult.map(path => Uri.joinPath(rootUri, path));
    }

    @throttle
    async remove(...uris: Uri[]): Promise<void> {
        let resources: FossilResource[];
        if (uris.length === 0) {
            resources = this._groups.untracked.resourceStates;
        } else {
            resources = this.mapResources(uris);
        }
        const relativePaths: string[] = resources.map(r =>
            this.mapResourceToRepoRelativePath(r)
        );
        await this.run(Operation.Remove, () =>
            this.repository.remove(relativePaths)
        );
    }

    @throttle
    async ignore(...uris: Uri[]): Promise<void> {
        let resources: FossilResource[];
        if (uris.length === 0) {
            resources = this._groups.untracked.resourceStates;
        } else {
            resources = this.mapResources(uris);
        }
        const relativePaths: string[] = resources.map(r =>
            this.mapResourceToRepoRelativePath(r)
        );
        await this.run(Operation.Ignore, () =>
            this.repository.ignore(relativePaths)
        );
    }

    mapResources(resourceUris: Uri[]): FossilResource[] {
        const resources: FossilResource[] = [];
        const { conflict, merge, working, untracked, staging } = this._groups;
        const groups = [working, staging, merge, untracked, conflict];
        for (const uri of resourceUris) {
            let found = false;
            for (const group of groups) {
                const resource = group.getResource(uri);
                if (resource && !found) {
                    resources.push(resource);
                    found = true;
                }
            }
        }
        return resources;
    }

    @throttle
    async stage(...resourceUris: Uri[]): Promise<void> {
        await this.run(Operation.Stage, async () => {
            let resources = this.mapResources(resourceUris);

            if (resources.length === 0) {
                resources = this._groups.working.resourceStates;
            }

            const missingResources = partition(
                resources,
                r => r.status === Status.MISSING
            );

            if (missingResources[0].length) {
                const relativePaths: string[] = missingResources[0].map(r =>
                    this.mapResourceToRepoRelativePath(r)
                );
                await this.run(Operation.Remove, () =>
                    this.repository.remove(relativePaths)
                );
            }

            const untrackedResources = partition(
                resources,
                r => r.status === Status.UNTRACKED
            );

            if (untrackedResources[0].length) {
                const relativePaths: string[] = untrackedResources[0].map(r =>
                    this.mapResourceToRepoRelativePath(r)
                );
                await this.run(Operation.Remove, () =>
                    this.repository.add(relativePaths)
                );
            }

            this._groups.staging.intersect(resources);
            this._groups.working.except(resources);
            this._onDidChangeResources.fire();
        });
    }

    // resource --> repo-relative path
    public mapResourceToRepoRelativePath(resource: FossilResource): string {
        const relativePath = this.mapFileUriToRepoRelativePath(
            resource.resourceUri
        );
        return relativePath;
    }

    // file uri --> repo-relative path
    private mapFileUriToRepoRelativePath(fileUri: Uri): string {
        const relativePath = path
            .relative(this.repository.root, fileUri.fsPath)
            .replace(/\\/g, '/');
        return relativePath;
    }

    // resource --> workspace-relative path
    public mapResourceToWorkspaceRelativePath(
        resource: FossilResource
    ): string {
        const relativePath = this.mapFileUriToWorkspaceRelativePath(
            resource.resourceUri
        );
        return relativePath;
    }

    // file uri --> workspace-relative path
    public mapFileUriToWorkspaceRelativePath(fileUri: Uri): string {
        const relativePath = path
            .relative(this.repository.root, fileUri.fsPath)
            .replace(/[/\\]/g, path.sep);
        return relativePath;
    }

    // repo-relative path --> workspace-relative path
    private mapRepositoryRelativePathToWorkspaceRelativePath(
        repoRelativeFilepath: string
    ): string {
        const fsPath = path.join(this.repository.root, repoRelativeFilepath);
        const relativePath = path
            .relative(this.repository.root, fsPath)
            .replace(/[/\\]/g, path.sep);
        return relativePath;
    }

    @throttle
    async unstage(...uris: Uri[]): Promise<void> {
        let resources = this.mapResources(uris);
        if (resources.length === 0) {
            resources = this._groups.staging.resourceStates;
        }
        // const relativePaths: string[] = resources.map(r => this.mapResourceToRepoRelativePath(r));
        // await this.run(Operation.Remove, () => this.repository.revert(relativePaths));

        this._groups.staging.except(resources);
        this._groups.working.intersect(resources);
        // todo: remove useless event
        this._onDidChangeResources.fire();
    }

    @throttle
    async commit(
        message: string,
        opts: CommitOptions = Object.create(null)
    ): Promise<void> {
        await this.run(Operation.Commit, async () => {
            let fileList: string[] = [];
            if (opts.scope === CommitScope.STAGED_CHANGES) {
                fileList = this.stagingGroup.resourceStates.map(r =>
                    this.mapResourceToRepoRelativePath(r)
                );
            } else if (opts.scope === CommitScope.CHANGES) {
                fileList = this.workingDirectoryGroup.resourceStates.map(r =>
                    this.mapResourceToRepoRelativePath(r)
                );
            }
            const user = typedConfig.username;
            await this.repository.commit(message, { fileList, user });
            return;
        });
    }

    // async cleanOrUpdate(...resources: Uri[]) {
    //     const parents = await this.getParents();
    //     if (parents.length > 1) {
    //         return this.update('', { discard: true });
    //     }

    //     return this.clean(...resources);
    // }

    // @throttle
    // async clean(...uris: Uri[]): Promise<void> {
    //     let resources = this.mapResources(uris);
    //     await this.run(Operation.Clean, async () => {
    //         const toRevert: string[] = [];
    //         const toForget: string[] = [];

    //         for (let r of resources) {
    //             switch (r.status) {
    //                 case Status.UNTRACKED:
    //                 case Status.IGNORED:
    //                     break;

    //                 case Status.ADDED:
    //                     toForget.push(this.mapResourceToRepoRelativePath(r));
    //                     break;

    //                 case Status.DELETED:
    //                 case Status.MISSING:
    //                 case Status.MODIFIED:
    //                 default:
    //                     toRevert.push(this.mapResourceToRepoRelativePath(r));
    //                     break;
    //             }
    //         }

    //         const promises: Promise<void>[] = [];

    //         if (toRevert.length > 0) {
    //             promises.push(this.repository.revert(toRevert));
    //         }

    //         if (toForget.length > 0) {
    //             promises.push(this.repository.remove(toForget));
    //         }

    //         await Promise.all(promises);
    //     });
    // }

    @throttle
    async revert(...uris: Uri[]): Promise<void> {
        const resources = this.mapResources(uris);
        await this.run(Operation.Revert, async () => {
            const toRevert: string[] = [];

            for (const r of resources) {
                switch (r.status) {
                    case Status.UNTRACKED:
                    case Status.IGNORED:
                        break;
                    default:
                        toRevert.push(this.mapResourceToRepoRelativePath(r));
                        break;
                }
            }

            const promises: Promise<void>[] = [];

            if (toRevert.length > 0) {
                promises.push(this.repository.revert(toRevert));
            }

            await Promise.all(promises);
        });
    }

    @throttle
    async clean(): Promise<void> {
        await this.run(Operation.Clean, async () => {
            this.repository.clean();
        });
    }

    @throttle
    async branch(name: string): Promise<void> {
        await this.run(Operation.Branch, () => this.repository.branch(name));
    }

    @throttle
    async update(treeish: string, opts?: { discard: boolean }): Promise<void> {
        await this.run(Operation.Update, () =>
            this.repository.update(treeish, opts)
        );
    }

    @throttle
    async close(): Promise<boolean> {
        const msg = await this.run(Operation.Close, () =>
            this.repository.close()
        );
        if (msg) {
            interaction.warnUnsavedChanges(msg);
            return false;
        }
        return true;
    }

    @throttle
    async undo(dryRun: boolean): Promise<FossilUndoDetails> {
        const op = dryRun ? Operation.UndoDryRun : Operation.Undo;
        console.log('Running undo with dryrun ' + dryRun);
        const undo = await this.run(op, () => this.repository.undo(dryRun));

        return undo;
    }

    public isInAnyGroup(uri: Uri): boolean {
        return [
            this.workingDirectoryGroup,
            this.stagingGroup,
            this.mergeGroup,
            this.conflictGroup,
        ].some(group => group.includesUri(uri));
    }

    public async createPullOptions(): Promise<PullOptions> {
        return { autoUpdate: typedConfig.autoUpdate };
    }

    async changeInoutAfterDelay(delayMillis = 3000): Promise<void> {
        try {
            // then confirm after delay
            if (delayMillis) {
                await delay(delayMillis);
            }
            this._onDidChangeInOutState.fire();
        } catch (err) {
            if (err instanceof FossilError) {
                this.changeAutoInoutState({
                    status: AutoInOutStatuses.Error,
                    error: (
                        (err.stderr || '').replace(/^abort:\s*/, '') ||
                        err.fossilErrorCode ||
                        err.message
                    ).trim(),
                });
            }
            throw err;
        }
    }

    @throttle
    async pull(options?: PullOptions): Promise<void> {
        await this.run(Operation.Pull, async () => {
            await this.repository.pull(options);
        });
    }

    @throttle
    async push(path: string | undefined): Promise<void> {
        return await this.run(Operation.Push, async () => {
            try {
                this._lastPushPath = path;
                await this.repository.push();
            } catch (e) {
                if (
                    e instanceof FossilError &&
                    e.fossilErrorCode ===
                        FossilErrorCodes.PushCreatesNewRemoteHead
                ) {
                    const action = await interaction.warnPushCreatesNewHead();
                    if (action === PushCreatesNewHeadAction.Pull) {
                        commands.executeCommand('fossil.pull');
                    }
                    return;
                }

                throw e;
            }
        });
    }

    @throttle
    merge(revQuery: string): Promise<IMergeResult> {
        return this.run(Operation.Merge, async () => {
            try {
                return await this.repository.merge(revQuery);
            } catch (e) {
                if (
                    e instanceof FossilError &&
                    e.fossilErrorCode ===
                        FossilErrorCodes.UntrackedFilesDiffer &&
                    e.hgFilenames
                ) {
                    e.hgFilenames = e.hgFilenames.map(filename =>
                        this.mapRepositoryRelativePathToWorkspaceRelativePath(
                            filename
                        )
                    );
                }
                throw e;
            }
        });
    }

    async show(params: FossilUriParams): Promise<string> {
        // TODO@Joao: should we make this a general concept?
        await this.whenIdleAndFocused();

        return await this.run(Operation.Show, async () => {
            const relativePath = path
                .relative(this.repository.root, params.path)
                .replace(/\\/g, '/');
            try {
                console.log(
                    'Repository: show: relativePath: ' +
                        relativePath +
                        ' checkin: ' +
                        params.checkin
                );
                return await this.repository.cat(relativePath, params.checkin!);
            } catch (e) {
                if (e instanceof FossilError) {
                    if (e.fossilErrorCode === FossilErrorCodes.NoSuchFile) {
                        return '';
                    }

                    if (e.exitCode !== 0) {
                        throw new FossilError({
                            message: localize(
                                'cantshow',
                                'Could not show object'
                            ),
                            exitCode: e.exitCode,
                        });
                    }
                }

                throw e;
            }
        });
    }

    private async run<T>(
        operation: Operation,
        runOperation: () => Promise<T> = () => Promise.resolve<any>(null)
    ): Promise<T> {
        if (this.state !== RepositoryState.Idle) {
            throw new Error('Repository not initialized');
        }

        return window.withProgress(
            { location: ProgressLocation.SourceControl },
            async () => {
                this._operations = this._operations.start(operation);
                this._onRunOperation.fire(operation);

                try {
                    const result = await runOperation();

                    if (!isReadOnly(operation)) {
                        try {
                            await this.updateModelState();
                        } catch (err) {
                            // expected to get here on executing `fossil close` operation
                            if (
                                err instanceof FossilError &&
                                err.fossilErrorCode ===
                                    FossilErrorCodes.NotAFossilRepository
                            ) {
                                this.state = RepositoryState.Disposed;
                            } else {
                                throw err;
                            }
                        }
                    }
                    return result;
                } catch (err) {
                    // we might get in this catch() when user deleted all files
                    if (
                        err instanceof FossilError &&
                        err.fossilErrorCode ===
                            FossilErrorCodes.NotAFossilRepository
                    ) {
                        this.state = RepositoryState.Disposed;
                    }
                    throw err;
                } finally {
                    this._operations = this._operations.end(operation);
                    this._onDidRunOperation.fire(operation);
                }
            }
        );
    }

    private async updateRepositoryPaths() {
        try {
            this._path = await this.repository.getPaths();
        } catch (e) {
            // noop
        }
    }

    @throttle
    public async getPath(): Promise<Path> {
        try {
            this._path = await this.repository.getPaths();
            return this._path;
        } catch (e) {
            // noop
        }

        return { name: '', url: '' };
    }

    @throttle
    public async getRefs(): Promise<Ref[]> {
        const [branches, tags] = await Promise.all([
            this.repository.getBranches(),
            this.repository.getTags(),
        ]);
        return [...branches, ...tags];
    }

    @throttle
    public getParents(): Promise<string> {
        return this.repository.getParents();
    }

    @throttle
    public getBranches(): Promise<Ref[]> {
        return this.repository.getBranches();
    }

    @throttle
    public async getCommitDetails(revision: string): Promise<CommitDetails> {
        const commitPromise = this.getLogEntries({
            revQuery: revision,
            limit: 1,
        });
        const fileStatusesPromise = await this.repository.getStatus();
        const parentsPromise = await this.getParents();

        const [[commit], fileStatuses] = await Promise.all([
            commitPromise,
            this.repository.parseStatusLines(fileStatusesPromise),
        ]);

        return {
            ...commit,
            parent1: parentsPromise,
            files: fileStatuses,
        };
    }

    @throttle
    public getLogEntries(options: LogEntriesOptions = {}): Promise<Commit[]> {
        let filePath: string | undefined = undefined;
        if (options.file) {
            filePath = this.mapFileUriToRepoRelativePath(options.file);
        }

        const opts: LogEntryRepositoryOptions = {
            revQuery: options.revQuery || '',
            filePath: filePath,
            limit: options.limit || 200,
        };
        return this.repository.getLogEntries(opts);
    }

    @throttle
    private async updateModelState(): Promise<void> {
        this._repoStatus = await this.repository.getSummary();

        const currentRefPromise: Promise<Ref | undefined> =
            this.repository.getCurrentBranch();

        const fileStat = this.repository
            .parseStatusLines(await this.repository.getStatus())
            .concat(
                this.repository.parseExtrasLines(
                    await this.repository.getExtras()
                )
            );

        const [currentRef, _resolveStatuses] = await Promise.all([
            currentRefPromise,
            Promise.resolve(undefined),
        ]);

        this._currentBranch = currentRef;

        const groupInput: IGroupStatusesParams = {
            respositoryRoot: this.repository.root,
            fileStatuses: fileStat,
            // repoStatus: this._repoStatus,
            resolveStatuses: undefined,
            statusGroups: this._groups,
        };

        groupStatuses(groupInput);
        this._sourceControl.count = this.count;
        this._onDidChangeStatus.fire();
        // this._onDidChangeRepository.fire()
    }

    get count(): number {
        return (
            this.mergeGroup.resourceStates.length +
            this.stagingGroup.resourceStates.length +
            this.workingDirectoryGroup.resourceStates.length +
            this.conflictGroup.resourceStates.length +
            this.untrackedGroup.resourceStates.length
        );
    }

    dispose(): void {
        this.disposables = dispose(this.disposables);
    }
}
