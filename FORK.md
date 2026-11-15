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
