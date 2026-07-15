import { expect, test } from "bun:test"
import { marketLocalErrorCodes } from "./desktop-source"
import { skillMarketErrorKey } from "./errors"

test("maps every local error code to a stable localized key", () => {
  expect(marketLocalErrorCodes.map(skillMarketErrorKey)).toEqual(
    marketLocalErrorCodes.map((code) => `skillMarket.error.${code}` as const),
  )
})
