import { CleanupEngine, failureCode, isFatal, type BrickRow, type Cleanup, type Target, type WorkItem } from '../cleanup.js';
import { NotFoundError, type DriveApi, type GoogleGateway, type GoogleTokens } from '../google.js';
import type { Store } from '../store.js';
import { drain, type Pacer, type ThrottleOptions } from '../throttle.js';
import type { DriveStore } from './store.js';

/** Actions de nettoyage de Drive ; la restauration part du journal. */
export const DRIVE_ACTIONS = ['trash', 'delete', 'untrash'] as const;

// Drive tolère mal les écritures soutenues : au débit par défaut (200 unités/s), ce coût donne 4 fichiers par seconde.
const WRITE_COST = 50;
const CHUNK = 300;

/** Nettoyage de Drive : une brique visée est un fichier dont le compte est propriétaire. */
export class DriveCleaner extends CleanupEngine {
  protected readonly tables = { jobs: 'drive_cleanups', items: 'drive_cleanup_items' };
  readonly #drive: DriveStore;

  constructor(store: Store, drive: DriveStore, google: GoogleGateway | null, options: ThrottleOptions = {}) {
    super(store, drive, google, options);
    this.#drive = drive;
  }

  protected *bricks(accountId: number, targets: Target[]): Iterable<BrickRow> {
    for (const zone of ['files', 'trash']) {
      const ids = [...new Set(targets.filter((target) => target.zone === zone).map((target) => target.id))];
      for (let start = 0; start < ids.length; start += CHUNK) {
        const chunk = ids.slice(start, start + CHUNK);
        // Seuls les fichiers dont vous êtes propriétaire sont proposés : supprimer ceux des autres ne libérerait rien.
        yield* this.#drive
          .q(
            `SELECT id, ? AS zone, name AS subject, path AS domain, size, 1 AS msgs, MAX(shared, starred) AS flagged FROM drive_files
             WHERE account_id = ? AND folder = 0 AND owned = 1 AND trashed = ? AND id IN (${chunk.map(() => '?').join(', ')})`,
          )
          .all(zone, accountId, zone === 'trash' ? 1 : 0, ...chunk) as unknown as BrickRow[];
      }
    }
  }

  protected freeze(_accountId: number, brick: BrickRow): { ids: string[]; restore: string[] } {
    return { ids: [brick.id], restore: [] };
  }

  protected async execute(cleanup: Cleanup, run: Pacer, tokens: GoogleTokens): Promise<void> {
    const api = this.google!.drive(tokens, (fresh) => this.store.saveTokens(cleanup.accountId, fresh));
    await drain(3, () => this.pending(cleanup.id, 200), (item) => this.#one(api, run, cleanup, item));
  }

  /** Drive traite les fichiers un par un : la base suit chaque confirmation. */
  async #one(api: DriveApi, run: Pacer, cleanup: Cleanup, item: WorkItem): Promise<void> {
    const { accountId, action } = cleanup;
    try {
      await this.throttle.call(run, WRITE_COST, () =>
        action === 'delete' ? api.deleteFile(item.id) : action === 'trash' ? api.trashFile(item.id) : api.untrashFile(item.id),
      );
      if (action === 'delete') this.#drive.removeFile(accountId, item.id);
      else this.#drive.setTrashed(accountId, item.id, action === 'trash');
      this.settle(cleanup.id, item, null);
    } catch (error) {
      if (isFatal(error)) throw error;
      // Un fichier déjà disparu du compte n'est pas un échec : il n'y a plus rien à traiter.
      if (error instanceof NotFoundError) {
        this.#drive.removeFile(accountId, item.id);
        this.settle(cleanup.id, item, null);
      } else this.settle(cleanup.id, item, failureCode(error));
    }
  }
}
