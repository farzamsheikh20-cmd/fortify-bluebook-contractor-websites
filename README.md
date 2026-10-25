# Fortify Blue Book Contractor Websites

GitHub-ready Apify Actor for public The Blue Book contractor directories and iProView profiles. It discovers contractor profiles, collects external company websites, phones, addresses, trades, and public emails, and prevents duplicate profiles and website domains across continuation runs.

## Tested behavior

- Local direct requests to TheBlueBook.com returned HTTP 403, so residential proxy mode is enabled by default.
- Profile recognition, canonicalization, HTML discovery, external website selection, email filtering, schemas, and JavaScript syntax are covered by local tests.
- A small Apify run is required for final live verification because residential proxy access belongs to the Apify account.

## First Apify test

```json
{
  "startUrls": [
    "https://www.thebluebook.com/search.html?class=2200&region=36"
  ],
  "maximumNewCompanies": 5,
  "maximumProfilesVisited": 10,
  "maximumListingPagesThisRun": 1,
  "requireWebsite": true,
  "collectEmails": true,
  "visitCompanyWebsitesForEmails": false,
  "useResidentialProxy": true,
  "proxyCountryCode": "US",
  "campaignName": "bluebook-california-general-contractors-test",
  "resetProgress": true,
  "pageTimeoutSecs": 60,
  "delayMillis": 1200
}
```

Use 2 GB memory, a 1,800-second timeout, and a $1 maximum cost for the first run. After a successful test, keep the same campaign name and set `resetProgress` to `false` for continuation runs.

The Actor accepts multiple Blue Book search/category URLs and direct `iProView` profile URLs. It accesses public business pages only and does not sign in or access private project data.
