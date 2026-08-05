import type { MarketDatabase } from "./database"
import type { RestrictedCatalog } from "./restricted-catalog"
import type { Principal } from "./security"
import { hashSecret, randomSecret, SkillMarketSecurityError } from "./security"

const GrantLifetimeMilliseconds = 10 * 60_000

interface InstallGrantOptions {
  readonly database: MarketDatabase
  readonly restrictedCatalog: RestrictedCatalog
  readonly apiPublicUrl: string
  readonly now?: () => number
}

export function createInstallGrants(options: InstallGrantOptions) {
  return {
    issue(principal: Principal, publicationID: string) {
      options.restrictedCatalog.require(principal, publicationID)
      const token = randomSecret()
      const now = options.now?.() ?? Date.now()
      const expiresAt = now + GrantLifetimeMilliseconds
      options.database.transaction((connection) =>
        connection.run(
          `INSERT INTO private_install_grants
            (token_hash, publication_id, employee_id, expires_at, created_at)
           VALUES (?, ?, ?, ?, ?)`,
          [hashSecret(token), publicationID, principal.session.user.employeeID, expiresAt, now],
        ),
      )
      return {
        url: new URL(`/v1/private-download/${token}`, options.apiPublicUrl).href,
        expiresAt: new Date(expiresAt).toISOString(),
      }
    },

    resolve(token: string) {
      if (!/^[a-zA-Z0-9_-]{43}$/.test(token)) return undefined
      const now = options.now?.() ?? Date.now()
      const grant = options.database.connection
        .query<{ publication_id: string; employee_id: string }, [string, number]>(
          `SELECT publication_id, employee_id
           FROM private_install_grants
           WHERE token_hash = ? AND expires_at > ?`,
        )
        .get(hashSecret(token), now)
      if (!grant) return undefined
      try {
        return options.restrictedCatalog.requireEmployee(grant.employee_id, grant.publication_id)
      } catch (error) {
        if (error instanceof SkillMarketSecurityError && error.code === "not-found") return undefined
        throw error
      }
    },
  }
}

export type InstallGrants = ReturnType<typeof createInstallGrants>
