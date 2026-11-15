# Fork notes — SuperJeason/pi-web-access

Personal fork of [nicobailon/pi-web-access](https://github.com/nicobailon/pi-web-access).
Keep the delta minimal so `git pull upstream main` stays a clean merge.

## Local change 1 — `SearchType: "web"` for Searchinfinity (searchinfinity.ts)

Upstream `buildSearchBody()` posts only `{Query, Count, Filter?, TimeRange?}`.
Volcengine's China endpoint (`https://open.feedcoopapi.com/search_api/web_search`,
豆包搜索 / 联网搜索) marks `SearchType` as required and answers

```json
{"ResponseMetadata":{"Error":{"CodeN":10400,"Code":"10400","Message":"query or search type is empty"}}}
```

when it is missing. BytePlus's international endpoint
(`https://torchlight.byteintlapi.com/search_api/web_search`, the provider default)
tolerates the omission, so upstream never hit this.

Status: not fixed upstream as of `v0.48.0` (2026-11-13); no issue filed there yet.

## Config used with this fork (`~/.pi/web-search.json`)

```json
{
  "searchinfinityApiKey": "<Volcengine 豆包搜索 API Key>",
  "searchinfinityBaseUrl": "https://open.feedcoopapi.com",
  "searchRouting": {
    "providers": ["tavily", "searchinfinity"],
    "fallbackOn": ["quota", "network", "transient", "invalid-response", "empty"]
  }
}
```

`searchinfinityBaseUrl` must point at the China endpoint; the built-in default is
the BytePlus international host, whose keys are not interchangeable.
The 500 free searches/month quota is per Volcengine account and shared with every
other way of calling 豆包搜索.

## Local change 2 — new `zhihu` provider (知乎开放平台站内搜索)

Added `zhihu.ts` and wired it into `gemini-search.ts`, `index.ts`,
`curator-page.ts`, `curator-server.ts`.

- Endpoint: `GET https://developer.zhihu.com/api/v1/content/zhihu_search`
  (`Query`, `Count` ≤ 10), envelope `{ Code, Message, Data: { Items } }`.
- Auth: `Authorization: Bearer <Access Secret>` **plus** `X-Request-Timestamp`
  (seconds). Without the timestamp header the API answers `Code 20001`.
- Item fields used: `Title`, `Url`, `ContentText`, `ContentType`, `AuthorName`,
  `AuthorityLevel`, `VoteUpCount`, `CommentCount`, `EditTime` (unix seconds).
- `recencyFilter` and `domainFilter` are applied locally (the API has no such
  parameters); recency drops items with an `EditTime` older than the window.
- Explicit-only: listed in `RESOLVED_SEARCH_PROVIDERS`, deliberately **not** in
  `ALL_SEARCH_PROVIDERS`, so `auto` never picks it. Use `provider: "zhihu"` or
  put `"zhihu"` in `searchRouting.providers`.
- Config: `zhihuApiKey` (or `ZHIHU_API_KEY`), optional `zhihuBaseUrl`.
  Keys come from https://developer.zhihu.com/personal.
- Not added: `/api/v1/content/global_search` (全网搜索) — it would duplicate the
  Searchinfinity provider.
- Live-verified: `provider: "zhihu"` returns 10 items (answers + articles).
  `zhihu_search` quota is **5000/day** per `/api/v1/quota` (hot_list 100,
  global_search 5000, zdida 100).
- Gotcha: a single mistyped character inside the 40-hex Access Secret still
  looks plausible and yields the same `Code 20001` as a dead key, so verify
  with `uvx zhihu-search --quota` before blaming the code.

## Sync with upstream

```bash
cd ~/Projects/pi-web-access
git fetch upstream
git merge upstream/main        # or: git rebase upstream/main
git push origin main
```

If upstream ever adds `SearchType` itself, drop this commit instead of resolving
the conflict.

## Install

```bash
pi remove npm:pi-web-access
pi install ~/Projects/pi-web-access      # local path, TS sources, no build step
pi list                                  # expect a local path entry, not npm:
```
