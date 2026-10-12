import { MissingScopeError, ReauthRequiredError, RetryLaterError, type GoogleGateway } from '../google.js';
import type { Store } from '../store.js';
import { Stopped, Throttle, type Pacer, type ThrottleOptions } from '../throttle.js';
import { isScanning, type DriveScan, type DriveStore } from './store.js';

// Une page de 1000 fichiers par appel : même sur un gros Drive, le scan reste court.
const LIST_COST = 10;

export interface DriveScanProgress extends DriveScan {
  retryAt: number | null;
}

interface Run extends Pacer {
  finished: Promise<void>;
}

/** Lit en tâche de fond la liste des fichiers Drive du compte. */
export class DriveScanner {
  readonly #store: Store;
  readonly #drive: DriveStore;
  readonly #google: GoogleGateway | null;
  readonly #throttle: Throttle;
  readonly #runs = new Map<number, Run>();
  log?: { warn: (details: object, message: string) => void };

  constructor(store: Store, drive: DriveStore, google: GoogleGateway | null, options: ThrottleOptions = {}) {
    this.#store = store;
    this.#drive = drive;
    this.#google = google;
    this.#throttle = new Throttle(options);
  }

  /** Lance un scan ; refuse s'il y en a déjà un en cours pour ce compte. */
  start(accountId: number): DriveScan | null {
    if (isScanning(this.#drive.latestScan(accountId))) return null;
    const scan = this.#drive.createScan(accountId);
    this.#launch(scan);
    return scan;
  }

  /** Reprend un scan suspendu par l'expiration de l'autorisation Google. */
  resume(accountId: number): void {
    const scan = this.#drive.latestScan(accountId);
    if (scan?.status !== 'auth') return;
    this.#drive.updateScan(scan.id, { status: 'running', error: null });
    this.#launch(scan);
  }

  /** Abandonne le scan ; la base garde le résultat du scan précédent. */
  async cancel(accountId: number): Promise<void> {
    const scan = this.#drive.latestScan(accountId);
    if (!isScanning(scan)) return;
    await this.#halt(accountId);
    this.#drive.updateScan(scan!.id, { status: 'cancelled', finishedAt: Date.now() });
  }

  resumeInterrupted(): void {
    for (const scan of this.#drive.interruptedScans()) this.#launch(scan);
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.#runs.keys()].map((accountId) => this.#halt(accountId)));
  }

  /** Se résout quand plus aucun scan ne tourne (utile aux tests). */
  async idle(): Promise<void> {
    while (this.#runs.size > 0) await Promise.all([...this.#runs.values()].map((run) => run.finished));
  }

  progress(accountId: number): DriveScanProgress | null {
    const scan = this.#drive.latestScan(accountId);
    return scan && { ...scan, retryAt: this.#runs.get(accountId)?.retryAt ?? null };
  }

  async #halt(accountId: number): Promise<void> {
    const run = this.#runs.get(accountId);
    if (!run) return;
    run.stop = true;
    await run.finished;
  }

  #launch(scan: DriveScan): void {
    if (this.#runs.has(scan.accountId)) return;
    const run: Run = { stop: false, retryAt: null, finished: Promise.resolve() };
    this.#runs.set(scan.accountId, run);
    run.finished = this.#execute(scan, run)
      .catch((error: unknown) => {
        if (error instanceof Stopped) return;
        if (error instanceof ReauthRequiredError || error instanceof MissingScopeError) {
          if (error instanceof ReauthRequiredError) this.#store.markNeedsReauth(scan.accountId);
          this.#drive.updateScan(scan.id, { status: 'auth', error: error instanceof MissingScopeError ? 'autorisation-incomplete' : null });
          return;
        }
        this.log?.warn({ err: error, scanId: scan.id }, 'Scan Drive en échec');
        this.#drive.updateScan(scan.id, {
          status: 'failed',
          error: error instanceof RetryLaterError ? 'google-indisponible' : 'erreur-interne',
          finishedAt: Date.now(),
        });
      })
      .finally(() => this.#runs.delete(scan.accountId));
  }

  async #execute(initial: DriveScan, run: Run): Promise<void> {
    const accountId = initial.accountId;
    const tokens = this.#store.getTokens(accountId);
    if (!this.#google || !tokens) throw new ReauthRequiredError('Aucune autorisation Google en base');
    const api = this.#google.drive(tokens, (fresh) => this.#store.saveTokens(accountId, fresh));
    const scan = () => this.#drive.scan(initial.id)!;

    if (!scan().rootId) {
      this.#drive.updateScan(initial.id, { rootId: await this.#throttle.call(run, LIST_COST, () => api.rootId()) });
    }
    // Le jeton de page est enregistré après chaque page : un scan interrompu reprend à la page suivante.
    let pageToken = scan().pageToken ?? undefined;
    let first = scan().seen === 0;
    while (first || pageToken) {
      first = false;
      const token = pageToken;
      const page = await this.#throttle.call(run, LIST_COST, () => api.listFiles(token));
      this.#drive.saveFiles(scan(), page.files);
      pageToken = page.nextPageToken;
      this.#drive.updateScan(initial.id, { pageToken: pageToken ?? null, seen: scan().seen + page.files.length });
    }
    this.#drive.finishScan(scan());
    this.#drive.updateScan(initial.id, { status: 'done', finishedAt: Date.now() });
  }
}
