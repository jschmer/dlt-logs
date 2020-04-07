/* --------------------
 * Copyright(C) Matthias Behr.
 */

import * as vscode from 'vscode';
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { DltParser, DltMsg, MSTP, MTIN_LOG, MTIN_CTRL } from './dltParser';
import { DltLifecycleInfo } from './dltLifecycle';
import { TreeViewNode, FilterNode } from './dltDocumentProvider';
import { DltFilter, DltFilterType } from './dltFilter';
import TelemetryReporter from 'vscode-extension-telemetry';

function sleep(ms: number): Promise<void> { // todo move into util
    return new Promise(resolve => {
        setTimeout(resolve, ms);
    });
}

export class DltDocument {
    static dltP: DltParser = new DltParser();

    uri: vscode.Uri;
    textDocument: vscode.TextDocument | undefined = undefined;
    private _reporter?: TelemetryReporter;

    private _fileUri: vscode.Uri;
    private _parsedFileLen: number = 0; // we parsed that much yet
    private _docEventEmitter: vscode.EventEmitter<vscode.FileChangeEvent[]>;

    msgs = new Array<DltMsg>();
    filteredMsgs: DltMsg[] | undefined = undefined;
    lifecycles = new Map<string, DltLifecycleInfo[]>();

    // filters:
    posFilters: DltFilter[] = [];
    negFilters: DltFilter[] = [];
    loadTimePosFilters: DltFilter[] = [];
    loadTimeNegFilters: DltFilter[] = [];
    decFilters: DltFilter[] = [];
    disabledFilters: DltFilter[] = [];

    private _renderTriggered: boolean = false;
    private _renderPending: boolean = false;

    private _skipMsgs: number = 0; // that many messages get skipped from msgs/filteredMsgs
    private _staticLinesAbove: string[] = []; // number of static lines e.g. "...skipped ... msgs..."
    // todo private _staticLinesBelow: string[] = []; // e.g. "... msgs not shown yet..."

    //  gets updated e.g. by notifyVisibleRange
    private _maxNrMsgs: number; //  setting 'dlt-logs.maxNumberLogs'. That many messages are displayed at once

    private _text: string; // the rendered text todo change into Buffer
    get text() {
        console.log(`DltDocument.text() returning text with len ${this._text.length}`);
        if (!this._renderPending) { this._renderTriggered = false; }
        return this._text;
    }

    lifecycleTreeNode: TreeViewNode;
    filterTreeNode: TreeViewNode;
    textEditors: Array<vscode.TextEditor> = []; // don't use in here!

    private _allDecorations?: Map<vscode.TextEditorDecorationType, vscode.DecorationOptions[]>;
    decorations?: Map<vscode.TextEditorDecorationType, vscode.DecorationOptions[]>; // filtered ones
    identifiedFileConfig?: any;
    // cachedTimes?: Array<Date>; // per line one date/time
    timeAdjustMs?: number; // adjust in ms

    private _realStat: fs.Stats;

    constructor(uri: vscode.Uri, docEventEmitter: vscode.EventEmitter<vscode.FileChangeEvent[]>,
        parentTreeNode: TreeViewNode, filterParentTreeNode: TreeViewNode, reporter?: TelemetryReporter) {
        this.uri = uri;
        this._reporter = reporter;
        this._docEventEmitter = docEventEmitter;
        //this._treeEventEmitter = treeEventEmitter;
        this._fileUri = uri.with({ scheme: "file" });
        if (!fs.existsSync(this._fileUri.fsPath)) {
            throw Error(`DltDocument file ${this._fileUri.fsPath} doesn't exist!`);
        }
        this._realStat = fs.statSync(uri.fsPath);

        // load filters: 
        this.filterTreeNode = { label: `${path.basename(this._fileUri.fsPath)}`, uri: this.uri, parent: parentTreeNode, children: [] };
        filterParentTreeNode.children.push(this.filterTreeNode);

        // todo add onDidChangeConfiguration handling to reflect filter changes at runtime
        {
            const filterObjs = vscode.workspace.getConfiguration().get<Array<object>>("dlt-logs.filters");
            this.parseFilterConfigs(filterObjs);
        }

        this.lifecycleTreeNode = { label: `${path.basename(this._fileUri.fsPath)}`, uri: this.uri, parent: parentTreeNode, children: [] };
        parentTreeNode.children.push(this.lifecycleTreeNode);

        const maxNrMsgsConf = vscode.workspace.getConfiguration().get<number>('dlt-logs.maxNumberLogs');
        this._maxNrMsgs = maxNrMsgsConf ? maxNrMsgsConf : 1000000; // 1mio default

        this._text = `Loading dlt document from uri=${this._fileUri.toString()} with max ${this._maxNrMsgs} msgs per page...`;

        const reReadTimeoutConf = vscode.workspace.getConfiguration().get<number>('dlt-logs.reReadTimeout');
        const reReadTimeout: number = reReadTimeoutConf ? reReadTimeoutConf : 1000; // 5s default

        setTimeout(() => {
            this.checkFileChanges();
        }, reReadTimeout);
    }

    stat(): vscode.FileStat {
        return {
            size: this._text.length, ctime: this._realStat.ctime.valueOf(), mtime: this._realStat.mtime.valueOf(),
            type: this._realStat.isDirectory() ? vscode.FileType.Directory : (this._realStat.isFile() ? vscode.FileType.File : vscode.FileType.Unknown)
        };
    }

    parseFilterConfigs(filterObjs: Object[] | undefined) {
        console.log(`parseFilterConfigs: have ${filterObjs?.length} filters to parse...`);
        if (filterObjs) {
            for (let i = 0; i < filterObjs.length; ++i) {
                try {
                    let filterConf = filterObjs[i];
                    let newFilter = new DltFilter(filterConf);
                    this.filterTreeNode.children.push(new FilterNode(null, this.filterTreeNode, newFilter));
                    if (newFilter.enabled) {
                        switch (newFilter.type) {
                            case DltFilterType.POSITIVE:
                                if (newFilter.atLoadTime) {
                                    this.loadTimePosFilters.push(newFilter);
                                } else {
                                    this.posFilters.push(newFilter);
                                }
                                break;
                            case DltFilterType.NEGATIVE:
                                if (newFilter.atLoadTime) {
                                    this.loadTimeNegFilters.push(newFilter);
                                } else {
                                    this.negFilters.push(newFilter);
                                }
                                break;
                            case DltFilterType.MARKER:
                                this.decFilters.push(newFilter);
                                break;
                        }
                    } else {
                        this.disabledFilters.push(newFilter);
                    }
                    console.log(` got filter: type=${newFilter.type}, enabled=${newFilter.enabled}, atLoadTime=${newFilter.atLoadTime}`, newFilter);
                } catch (error) {
                    console.log(`dlt-logs.parseFilterConfigs error:${error}`);
                }
            }
        }
        console.log(` have ${this.posFilters.length}/${this.loadTimePosFilters.length} pos., ${this.negFilters.length}/${this.loadTimeNegFilters.length} neg., ${this.decFilters.length} marker and ${this.disabledFilters.length} not enabled filters.`);
    }

    onFilterChange(filter: DltFilter) { // todo this is really dirty. need to reconsider these arrays...
        console.log(`onFilterChange filter.name=${filter.name}`);
        // was is disabledFilters?
        let wasDisabled: boolean = false;
        for (let i = 0; i < this.disabledFilters.length; ++i) {
            if (this.disabledFilters[i] === filter) {
                wasDisabled = true;
                this.disabledFilters.splice(i, 1);
                break;
            }
        }
        if (wasDisabled) {
            if (filter.enabled) {
                switch (filter.type) {
                    case DltFilterType.POSITIVE:
                        if (filter.atLoadTime) {
                            this.loadTimePosFilters.push(filter);
                        } else {
                            this.posFilters.push(filter);
                        }
                        break;
                    case DltFilterType.NEGATIVE:
                        if (filter.atLoadTime) {
                            this.loadTimeNegFilters.push(filter);
                        } else {
                            this.negFilters.push(filter);
                        }
                        break;
                    case DltFilterType.MARKER:
                        this.decFilters.push(filter);
                        break;
                }
            }
        } else {
            let slot: DltFilter[] | undefined = undefined;
            switch (filter.type) {
                case DltFilterType.POSITIVE:
                    if (filter.atLoadTime) {
                        slot = this.loadTimePosFilters;
                    } else {
                        slot = this.posFilters;
                    }
                    break;
                case DltFilterType.NEGATIVE:
                    if (filter.atLoadTime) {
                        slot = this.loadTimeNegFilters;
                    } else {
                        slot = this.negFilters;
                    }
                    break;
                case DltFilterType.MARKER:
                    slot = this.decFilters;
                    break;
            }
            let wasEnabled = false;
            if (slot) {
                for (let i = 0; i < slot.length; ++i) {
                    if (slot[i] === filter) {
                        wasEnabled = true;
                        slot.splice(i, 1);
                        break;
                    }
                }
            }
            if (wasEnabled) { this.disabledFilters.push(filter); }
        }
        this.applyFilter(undefined);
    }

    /* todo clearFilter() {
        this.filteredMsgs = undefined;
        this._docEventEmitter.fire([{ type: vscode.FileChangeType.Changed, uri: this.uri }]); // todo needs renderLines first!
    } */

    // todo config options for decorations
    private decWarning: vscode.TextEditorDecorationType = vscode.window.createTextEditorDecorationType({ borderColor: "orange", borderWidth: "1px", borderStyle: "dotted", overviewRulerColor: "orange", overviewRulerLane: 2 });
    private decError: vscode.TextEditorDecorationType = vscode.window.createTextEditorDecorationType({ borderColor: "red", borderWidth: "1px", borderStyle: "dotted", overviewRulerColor: "red", overviewRulerLane: 1 });
    private decFatal: vscode.TextEditorDecorationType = vscode.window.createTextEditorDecorationType({ borderColor: "red", borderWidth: "3px", borderStyle: "solid", overviewRulerColor: "red", overviewRulerLane: 7 });

    async applyFilter(progress: vscode.Progress<{ increment?: number | undefined, message?: string | undefined, }> | undefined) {
        this.filteredMsgs = [];
        // we can in parallel check criteria todo
        // but then add into filteredMsgs sequentially only

        // todo need to optimize speed here.
        // e.g. filter only until maxNrMsgs is there (and continue the rest in the background)
        // apply decorations in the background

        this._allDecorations = new Map<vscode.TextEditorDecorationType, vscode.DecorationOptions[]>();
        let numberDecorations: number = 0;
        const nrMsgs: number = this.msgs.length;
        let startTime = process.hrtime();
        for (let i = 0; i < nrMsgs; ++i) {
            if (i % 1000 === 0) { // provide process and responsiveness for UI:
                let curTime = process.hrtime(startTime);
                if (curTime[1] / 1000000 > 100) { // 100ms passed
                    if (progress) {
                        progress.report({ message: `filter processed ${i}/${nrMsgs} msgs.` });
                    }
                    await sleep(10); // 10ms each 100ms
                    startTime = process.hrtime();
                }
            }
            const msg = this.msgs[i];

            // check for visibility:
            // a msg is visible if:
            // no negative filter matches and
            // if any pos. filter exists: at least one positive filter matches (if no pos. filters exist -> treat as matching)
            let foundAfterPosFilters: boolean = this.posFilters.length ? false : true;
            if (this.posFilters.length) {
                // check the pos filters, break on first match:
                for (let j = 0; j < this.posFilters.length; ++j) {
                    if (this.posFilters[j].matches(msg)) {
                        foundAfterPosFilters = true;
                        break;
                    }
                }
            }
            let foundAfterNegFilters: boolean = foundAfterPosFilters;
            if (foundAfterNegFilters && this.negFilters.length) {
                // check the neg filters, break on first match:
                for (let j = 0; j < this.negFilters.length; ++j) {
                    if (this.negFilters[j].matches(msg)) {
                        foundAfterNegFilters = false;
                        break;
                    }
                }
            }

            if (foundAfterNegFilters) {
                this.filteredMsgs.push(msg);
                // any decorations? todo decFilter....

                if (msg.mstp === MSTP.TYPE_LOG && msg.mtin === MTIN_LOG.LOG_WARN) {
                    while (msg.decorations.length) { msg.decorations.pop(); }
                    msg.decorations.push([this.decWarning, [{ range: new vscode.Range(this.filteredMsgs.length - 1, 0, this.filteredMsgs.length - 1, 21), hoverMessage: `LOG_WARN` }]]);
                }
                if (msg.mstp === MSTP.TYPE_LOG && msg.mtin === MTIN_LOG.LOG_ERROR) {
                    while (msg.decorations.length) { msg.decorations.pop(); }
                    msg.decorations.push([this.decError, [{ range: new vscode.Range(this.filteredMsgs.length - 1, 0, this.filteredMsgs.length - 1, 21), hoverMessage: `LOG_ERROR` }]]);
                }
                if (msg.mstp === MSTP.TYPE_LOG && msg.mtin === MTIN_LOG.LOG_FATAL) {
                    while (msg.decorations.length) { msg.decorations.pop(); }
                    msg.decorations.push([this.decFatal, [{ range: new vscode.Range(this.filteredMsgs.length - 1, 0, this.filteredMsgs.length - 1, 21), hoverMessage: `LOG_FATAL` }]]);
                }
                for (let m = 0; m < msg.decorations.length; ++m) {
                    const value = msg.decorations[m];
                    if (!this._allDecorations?.has(value[0])) {
                        this._allDecorations?.set(value[0], []);
                    }
                    // adapt line here?
                    for (let d = 0; d < value[1].length; ++d) {
                        this._allDecorations?.get(value[0])?.push(value[1][d]);
                        numberDecorations++;
                    }
                }
            }
        }
        console.log(`applyFilter got ${numberDecorations} decorations.`);
        return this.renderLines(this._skipMsgs, progress);
    }

    lineCloseTo(index: number): number {
        // provides the line number "close" to the index 
        // todo this causes problems once we do sort msgs (e.g. by timestamp)
        // that is the matching line or the next higher one
        // todo use binary search
        if (this.filteredMsgs) {
            for (let i = 0; i < this.filteredMsgs.length; ++i) {
                if (this.filteredMsgs[i].index >= index) {

                    // is i skipped?
                    if (i < this._skipMsgs) {
                        console.log(`lineCloseTo(${index} not in range (<). todo needs to trigger reload.)`);
                        return this._staticLinesAbove.length; // go to first line
                    }
                    if (i > this._skipMsgs + this._maxNrMsgs) {
                        console.log(`lineCloseTo(${index} not in range (>). todo needs to trigger reload.)`);
                        return this._staticLinesAbove.length + this._maxNrMsgs; // go to first line    
                    }
                    return i + this._staticLinesAbove.length;
                }
            }
            return 0;
        } else {
            // todo check that index is not smaller...
            if (index < (this._skipMsgs + this._staticLinesAbove.length)) {
                console.log(`lineCloseTo(${index} not in range (<). todo needs to trigger reload.)`);
                return this._staticLinesAbove.length; // go to first line
            }
            if (index > (this._skipMsgs + this._maxNrMsgs)) {
                console.log(`lineCloseTo(${index} not in range (>). todo needs to trigger reload.)`);
                return this._staticLinesAbove.length + this._maxNrMsgs;
            }
            return index - this._skipMsgs - this._staticLinesAbove.length; // unfiltered: index = line nr. both zero-based
        }
    }

    lineCloseToDate(date: Date): number {
        console.log(`DltDocument.lineCloseToDate(${date.toLocaleTimeString()})...`);
        const dateValue = date.valueOf();

        // todo optimize with binary/tree search. with filteredMsgs it gets tricky.
        // so for now do linear scan...

        const msgs = this.filteredMsgs ? this.filteredMsgs : this.msgs;
        for (let i = 0; i < msgs.length; ++i) {
            const logMsg = msgs[i];
            if (!(logMsg.mstp === MSTP.TYPE_CONTROL && logMsg.mtin === MTIN_CTRL.CONTROL_REQUEST)) {
                const startDate = logMsg.lifecycle ? logMsg.lifecycle.lifecycleStart.valueOf() : logMsg.time.valueOf();
                if (startDate + (logMsg.timeStamp / 10) >= dateValue) {
                    console.log(`DltDocument.lineCloseToDate(${date.toLocaleTimeString()}) found line ${i}`);
                    return this.revealByMsgsIndex(i);
                }
            }
        }
        return -1;
    }

    msgByLine(line: number): DltMsg | undefined {
        const msgs = this.filteredMsgs ? this.filteredMsgs : this.msgs;
        // line = index
        if (line >= this._staticLinesAbove.length && line < (this._skipMsgs + msgs.length)) { // we don't have to check whether the msg is visible here
            return msgs[line + this._skipMsgs];
        } else {
            return;
        }
    }

    provideTimeByMsg(msg: DltMsg): Date | undefined {
        if ((msg.mstp === MSTP.TYPE_CONTROL && msg.mtin === MTIN_CTRL.CONTROL_REQUEST)) {
            return;
        }
        if (msg.lifecycle) {
            return new Date(0 + msg.lifecycle.lifecycleStart.valueOf() + (msg.timeStamp / 10));
        }
        return new Date(0 + msg.time.valueOf() + (msg.timeStamp / 10));
    }

    provideTimeByLine(line: number): Date | undefined {
        // provide the time fitting to that line
        // todo take adjustTime into account
        const msg = this.msgByLine(line);
        if (msg) {
            return this.provideTimeByMsg(msg);
        } else {
            return;
        }
    }

    public provideHover(position: vscode.Position): vscode.ProviderResult<vscode.Hover> {
        const msg = this.msgByLine(position.line);
        if (!msg) {
            return;
        }
        const posTime = this.provideTimeByMsg(msg);
        if (posTime) {
            return new vscode.Hover({ language: "dlt-log", value: `calculated time: ${posTime.toLocaleTimeString()}.${String(posTime.valueOf() % 1000).padStart(3, "0")} index#=${msg.index} timestamp=${msg.timeStamp} reception time=${msg.time.toLocaleTimeString()} mtin=${msg.mtin}` });
        } else {
            return new vscode.Hover({ language: "dlt-log", value: `calculated time: <none> index#=${msg.index} timestamp=${msg.timeStamp} reception time=${msg.time.toLocaleTimeString()}` });
        }
    }

    notifyVisibleRange(range: vscode.Range) {

        // we do show max _maxNrMsgs from [_skipMsgs, _skipMsgs+_maxNrMsgs)
        // and trigger a reload if in the >4/5 or <1/5
        // and jump by 0.5 then

        const triggerAboveLine = range.start.line;
        const triggerBelowLine = range.end.line;

        // console.log(` notifyVisibleRange(visible: [${triggerAboveLine}-${triggerBelowLine}]) current: [${this._skipMsgs}-${this._skipMsgs + this._maxNrMsgs})`);

        if (triggerAboveLine <= (this._maxNrMsgs * 0.2)) {
            // can we scroll to the top?
            if (this._skipMsgs > 0) {
                if (!this._renderTriggered) {
                    console.log(` notifyVisibleRange(visible: [${triggerAboveLine}-${triggerBelowLine}]) current: [${this._skipMsgs}-${this._skipMsgs + this._maxNrMsgs}) triggerAbove`);
                    this._renderTriggered = true;

                    if (this.textEditors && this.textEditors.length > 0) {
                        this.textEditors.forEach((editor) => {
                            const shiftByLines = +this._maxNrMsgs * 0.5;
                            let newRange = new vscode.Range(triggerAboveLine + shiftByLines, range.start.character,
                                triggerBelowLine + shiftByLines, range.end.character);
                            editor.revealRange(newRange, vscode.TextEditorRevealType.AtTop);
                        });
                    }

                    this.renderLines(this._skipMsgs - (this._maxNrMsgs * 0.5));
                }
            }
        }

        if (triggerBelowLine >= (this._maxNrMsgs * 0.8)) {
            // can we load more msgs?
            const msgs = this.filteredMsgs ? this.filteredMsgs : this.msgs;
            if (this._skipMsgs + this._maxNrMsgs < msgs.length) {
                if (!this._renderTriggered) {
                    console.log(` notifyVisibleRange(visible: [${triggerAboveLine}-${triggerBelowLine}]) current: [${this._skipMsgs}-${this._skipMsgs + this._maxNrMsgs}) triggerBelow`);
                    this._renderTriggered = true;

                    if (this.textEditors && this.textEditors.length > 0) {
                        this.textEditors.forEach((editor) => {
                            const shiftByLines = -this._maxNrMsgs * 0.5;
                            let newRange = new vscode.Range(triggerAboveLine + shiftByLines, range.start.character,
                                triggerBelowLine + shiftByLines, range.end.character);
                            editor.revealRange(newRange, vscode.TextEditorRevealType.AtTop);
                        });
                    }

                    this.renderLines(this._skipMsgs + (this._maxNrMsgs * 0.5));
                }
            }
        };
    }

    revealByMsgsIndex(i: number): number { // msgs Index = the i inside msgs/filteredMsgs[i]
        // return the line number that this msg will get
        // and trigger the reload if needed

        if (this._renderPending) {
            console.log('revealByMsgsIndex aborted due to renderPending!');
            return -1;
        }

        // currently visible?
        if (this._skipMsgs <= i && (this._skipMsgs + this._maxNrMsgs) > i) {
            return i - this._skipMsgs + this._staticLinesAbove.length;
        } else {
            // we do need to reveal it:
            // so that it ends up in the range 0.25-0.75
            const lowerLine = this._maxNrMsgs * 0.25;
            const upperLine = this._maxNrMsgs * 0.75;

            for (let newSkipMsgs = -this._maxNrMsgs; ; newSkipMsgs += this._maxNrMsgs / 2) { // todo might need special handling for upper bound!
                let newNr = i - newSkipMsgs;
                if (newNr >= lowerLine && newNr <= upperLine) {
                    // got it:
                    if (newSkipMsgs < 0) {
                        newNr = i;
                        newSkipMsgs = 0;
                    }
                    if (newSkipMsgs !== this._skipMsgs) {
                        this._renderTriggered = true;
                        this.renderLines(newSkipMsgs);
                    }
                    console.log(`revealByMsgsIndex(${i}) newSkipMsgs=${newSkipMsgs} newNr=${newNr}`);
                    return newNr; // todo staticLinesAbove?
                }
            }
            console.log(`revealByMsgsIndex(${i}) couldnt determine newSkipMsgs`);
            return -1;
        }
    }

    revealIndex(index: number): number { // return line nr that the msg with index will get:
        console.log(`revealIndex(${index})...`);
        if (this.filteredMsgs) { // todo renderTriggered needed?
            for (let i = 0; i < this.filteredMsgs.length; ++i) {
                if (this.filteredMsgs[i].index >= index) {
                    // we want line msg i:
                    return this.revealByMsgsIndex(i);
                }
            }
            console.log(` revealIndex(${index}) not found!`);
            return -1;
        } else {
            // here we can calc directly:
            // for now we assume index = i if not filtered.
            // todo recheck once the impl. for sorting by timestamp is available
            return this.revealByMsgsIndex(index);
        }

    }

    async renderLines(skipMsgs: number, progress?: vscode.Progress<{ increment?: number | undefined, message?: string | undefined, }>): Promise<void> {
        const fnStart = process.hrtime();
        console.log(`DltDocument.renderLines(${skipMsgs}) with ${this.filteredMsgs?.length}/${this.msgs.length} msgs ...`);
        if (this._renderPending) {
            console.error(`DltDocument.renderLines called while already running! Investigate / todo`);
        }
        this._renderPending = true;
        if (this.msgs.length === 0) {
            this._text = `Loading dlt document from uri=${this._fileUri.toString()}...`;
            this._renderPending = false;
            this._docEventEmitter.fire([{ type: vscode.FileChangeType.Changed, uri: this.uri }]);
            return;
        }

        let toRet: string = "";

        let msgs = this.filteredMsgs ? this.filteredMsgs : this.msgs;
        const maxLength = Math.floor(Math.log10(msgs.length)) + 1;

        if (msgs.length === 0) { // filter might lead to 0 msgs
            this._text = `<current filter leads to empty file>`;
            this._renderPending = false;
            this._docEventEmitter.fire([{ type: vscode.FileChangeType.Changed, uri: this.uri }]);
            return;
        }

        if (this._allDecorations?.size) {
            if (!this.decorations || this._skipMsgs !== skipMsgs) {

                if (progress) {
                    progress.report({ message: "renderLines: removing decorations" });
                    await sleep(10);
                }
                // remove decorations:
                this.textEditors.forEach((editor) => {
                    this.decorations?.forEach((value, key) => {
                        editor.setDecorations(key, []);
                    });
                });
                if (progress) {
                    progress.report({ message: "renderLines: adapting decorations" });
                    await sleep(10);
                }
                // need to adjust the visible decorations:
                this.decorations = new Map<vscode.TextEditorDecorationType, vscode.DecorationOptions[]>();
                // add all visible decorations:
                this._allDecorations.forEach((decOpts, decType) => {
                    let visibleDecOpts: vscode.DecorationOptions[] = [];
                    for (let i = 0; i < decOpts.length; ++i) {
                        const decOpt = decOpts[i];
                        if (decOpt.range.start.line >= skipMsgs && decOpt.range.start.line < skipMsgs + this._maxNrMsgs) {
                            let newDecOpt: vscode.DecorationOptions = {
                                renderOptions: decOpt.renderOptions, hoverMessage: decOpt.hoverMessage,
                                range: new vscode.Range(decOpt.range.start.line - skipMsgs - this._staticLinesAbove.length,
                                    decOpt.range.start.character,
                                    decOpt.range.end.line - skipMsgs - this._staticLinesAbove.length, decOpt.range.end.character)
                            };
                            visibleDecOpts.push(newDecOpt);
                        }
                    }
                    if (visibleDecOpts.length) {
                        this.decorations?.set(decType, visibleDecOpts);
                    }
                });
            }
        }

        const nrMsgs = msgs.length > this._maxNrMsgs ? this._maxNrMsgs : msgs.length;
        this._skipMsgs = skipMsgs;
        const renderRangeStartLine = skipMsgs;
        const renderRangeEndLine = skipMsgs + nrMsgs;

        console.log(` processing msg ${renderRangeStartLine}-${renderRangeEndLine}...`);

        const numberStart = renderRangeStartLine;
        let numberEnd = renderRangeEndLine - 1;
        assert(numberEnd >= numberStart, "logical error: numberEnd>=numberStart");
        toRet = "";
        // mention skipped lines?
        if (false && renderRangeStartLine > 0) { // todo someparts are off by 1 then
            this._staticLinesAbove = [];
            this._staticLinesAbove.push(`...skipped ${renderRangeStartLine} msgs...\n`);
            toRet += this._staticLinesAbove[0];
        }
        // todo render some at the end?

        let startTime = process.hrtime();
        for (let j = numberStart; j <= numberEnd && j < msgs.length; ++j) {
            const msg = msgs[j];
            try {
                toRet += String(`${String(msg.index).padStart(maxLength)} ${String(msg.ecu).padEnd(4)} ${String(msg.apid).padEnd(4)} ${String(msg.ctid).padEnd(4)} ${msg.payloadString}\n`);
            } catch (error) {
                console.error(`error ${error} at parsing msg ${j}`);
                await sleep(100); // avoid hard busy loops!
            }
            if (j % 1000 === 0) {
                let curTime = process.hrtime(startTime);
                if (curTime[1] / 1000000 > 100) { // 100ms passed
                    if (progress) {
                        progress.report({ message: `renderLines: processing msg ${j}` });
                        await sleep(10);
                    }
                    startTime = process.hrtime();
                }
            }
        }

        // need to remove current text in the editor and insert new one.
        // otherwise the editor tries to identify the changes. that
        // lasts long on big files...
        // tried using editor.edit(replace or remove/insert) but that leads to a 
        // doc marked with changes and then FileChange event gets ignored...
        // so we add empty text interims wise:
        this._text = "...revealing new range...";
        this._docEventEmitter.fire([{ type: vscode.FileChangeType.Changed, uri: this.uri }]);
        await sleep(100);

        this._text = toRet;
        const fnEnd = process.hrtime(fnStart);
        console.info('DltDocument.renderLines() took: %ds %dms', fnEnd[0], fnEnd[1] / 1000000);
        await sleep(10); // todo not needed anylonger?
        this._docEventEmitter.fire([{ type: vscode.FileChangeType.Changed, uri: this.uri }]);
        this._renderPending = false;

    }

    async checkFileChanges() {
        // we want this to be callable from file watcher as well
        // we will assume that only additional data has been written
        // so we parse from _parsedFileLen to the end:
        const fnStart = process.hrtime();
        const stats = fs.statSync(this._fileUri.fsPath);
        if (stats.size > this._parsedFileLen) {
            if (this._reporter && this._parsedFileLen === 0) {
                this._reporter.sendTelemetryEvent("open file", undefined, { 'fileSize': stats.size });
            }
            const fd = fs.openSync(this._fileUri.fsPath, "r");
            let read: number = 0;
            let chunkSize = 10 * 1024 * 1024; // todo config
            if ((stats.size - this._parsedFileLen) < chunkSize) {
                chunkSize = stats.size - this._parsedFileLen;
            }

            return vscode.window.withProgress({ cancellable: false, location: vscode.ProgressLocation.Notification, title: "loading dlt file..." },
                async (progress) => {
                    // do we have any filters to apply at load time?
                    let posFilters: DltFilter[] = [];
                    let negFilters: DltFilter[] = [];

                    for (let i = 0; i < this.loadTimePosFilters.length; ++i) {
                        if (this.loadTimePosFilters[i].enabled) {
                            posFilters.push(this.loadTimePosFilters[i]);
                        }
                    }
                    for (let i = 0; i < this.loadTimeNegFilters.length; ++i) {
                        if (this.loadTimeNegFilters[i].enabled) {
                            negFilters.push(this.loadTimeNegFilters[i]);
                        }
                    }
                    console.log(` have ${posFilters.length} pos. and ${negFilters.length} neg. filters at load time.`);

                    let data = Buffer.allocUnsafe(chunkSize);
                    let startTime = process.hrtime();
                    do {
                        read = fs.readSync(fd, data, 0, chunkSize, this._parsedFileLen);
                        if (read) {
                            // parse data:
                            let parseInfo = DltDocument.dltP.parseDltFromBuffer(Buffer.from(data.slice(0, read)), 0, this.msgs, posFilters, negFilters); // have to create a copy of Buffer here!
                            if (parseInfo[0] > 0) {
                                console.log(`checkFileChanges skipped ${parseInfo[0]} bytes.`);
                            }
                            if (parseInfo[1] > 0) {
                                console.log(`checkFileChanges read=${read} remaining=${parseInfo[1]} bytes. Parse ${parseInfo[2]} msgs.`);
                            }
                            if (read !== parseInfo[1]) {
                                this._parsedFileLen += read - parseInfo[1];
                                let curTime = process.hrtime(startTime);
                                if (curTime[1] / 1000000 > 100) { // 100ms passed
                                    progress.report({ message: `processed ${this._parsedFileLen} from ${stats.size} bytes` });
                                    await sleep(10); // 10ms each 100ms
                                    startTime = process.hrtime();
                                }
                            } else {
                                console.log(`checkFileChanges read=${read} remaining=${parseInfo[1]} bytes. Parse ${parseInfo[2]} msgs. Stop parsing to avoid endless loop.`);
                                read = 0;
                            }
                        }
                    } while (read > 0);
                    fs.closeSync(fd);
                    const readEnd = process.hrtime(fnStart);
                    console.info('checkFileChanges read took: %ds %dms', readEnd[0], readEnd[1] / 1000000);
                    progress.report({ message: `reading done. Determining lifecycles...` });
                    await sleep(50);
                    const lcStart = process.hrtime();
                    // update lifecycles:
                    // todo have to add an index here to updateLifecycles. for now clear the lifecycles:
                    this.lifecycles.clear();
                    DltLifecycleInfo.updateLifecycles(this.msgs, this.lifecycles);
                    // update the lifecycleNode:
                    this.lifecycleTreeNode.children = [];
                    this.lifecycles.forEach((lcInfo, ecu) => {
                        let ecuNode: TreeViewNode = { label: `ECU: ${ecu}`, parent: this.lifecycleTreeNode, children: [], uri: this.uri };
                        this.lifecycleTreeNode.children.push(ecuNode);
                        console.log(`${ecuNode.label}`);
                        // add lifecycles
                        for (let i = 0; i < lcInfo.length; ++i) {
                            const lc = lcInfo[i];
                            let lcNode: TreeViewNode = {
                                label: `${lc.lifecycleStart.toUTCString()}-${lc.lifecycleEnd.toUTCString()} #${lc.logMessages.length}`,
                                parent: ecuNode, children: [], uri: this.uri.with({ fragment: lc.startIndex.toString() })
                            };
                            ecuNode.children.push(lcNode);
                        }
                    });
                    const lcEnd = process.hrtime(lcStart);
                    console.info('checkFileChanges lcUpdate took: %ds %dms', lcEnd[0], lcEnd[1] / 1000000);
                    progress.report({ message: `Got ${this.lifecycles.size} ECUs. Applying filter...` });
                    await sleep(50);
                    const applyFilterStart = process.hrtime();
                    /* todo jft */ await this.applyFilter(progress); // await wouldn't be necessary but then we keep the progress info open
                    const applyFilterEnd = process.hrtime(applyFilterStart);
                    console.info('checkFileChanges applyFilter took: %ds %dms', applyFilterEnd[0], applyFilterEnd[1] / 1000000);
                    progress.report({ message: `Filter applied. Finish. (gc kicks in now frequently...)` });
                    await sleep(50);
                }
            ).then(() => {
                const fnEnd = process.hrtime(fnStart);
                console.info('checkFileChanges took: %ds %dms', fnEnd[0], fnEnd[1] / 1000000);
            });
        } else {
            console.log(`checkFileChanges no file size increase (size=${stats.size} vs ${this._parsedFileLen})`);
        }
    }
};