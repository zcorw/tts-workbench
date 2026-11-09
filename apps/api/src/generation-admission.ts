import type { Pool } from "pg";

// Shared by HTTP generation and the batch worker, including across app processes.
// A queued item does not consume a slot until it is about to start.
export class GenerationAdmission {
  constructor(private pool: Pool) {}

  async acquire(
    owner: string,
  ): Promise<{ allowed: boolean; retryAfterMs: number }> {
    const result = await this.pool.query(
      `INSERT INTO wb_tts_admission(account_id,window_started_at,used)
       VALUES($1,clock_timestamp(),1)
       ON CONFLICT(account_id) DO UPDATE SET
         window_started_at=CASE WHEN wb_tts_admission.window_started_at<=clock_timestamp()-interval '60 seconds'
           THEN clock_timestamp() ELSE wb_tts_admission.window_started_at END,
         used=CASE WHEN wb_tts_admission.window_started_at<=clock_timestamp()-interval '60 seconds'
           THEN 1 ELSE wb_tts_admission.used+1 END
       WHERE wb_tts_admission.used<10 OR wb_tts_admission.window_started_at<=clock_timestamp()-interval '60 seconds'
       RETURNING used`,
      [owner],
    );
    if (result.rowCount) return { allowed: true, retryAfterMs: 0 };
    const wait = await this.pool.query(
      `SELECT GREATEST(1,ceil(extract(epoch FROM
        window_started_at+interval '60 seconds'-clock_timestamp())*1000)) AS ms
       FROM wb_tts_admission WHERE account_id=$1`,
      [owner],
    );
    return { allowed: false, retryAfterMs: Number(wait.rows[0]?.ms ?? 1000) };
  }
}
