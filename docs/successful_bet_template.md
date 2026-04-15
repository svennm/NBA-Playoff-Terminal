# Successful Bet Template
**Based on:** *Sharp Sports Betting* by Stanford Wong

---

## PRE-BET CHECKLIST

| Step | Question | Your Answer |
|------|----------|-------------|
| 1 | **Estimated win probability?** | ___% |
| 2 | **Break-even at these terms?** | ___% (use break-even table below) |
| 3 | **Your prob > break-even?** | YES / NO → if NO, stop |
| 4 | **Edge?** `(Win% × payout) - 1` | ___% |
| 5 | **Edge ≥ MinEdge (5%)?** | YES / NO → if NO, stop |
| 6 | **Edge source?** | News / Data / Motivation / Fan Money |
| 7 | **Line shopped (12+ books)?** | YES / NO |
| 8 | **Key number half-point available?** | YES / NO |

### Quick Break-Even Reference

| Terms | Break-Even Win% |
|-------|----------------|
| +200 | 33.3% |
| +145 | 40.8% |
| +115 | 46.5% |
| EV | 50.0% |
| -110 | 52.38% |
| -120 | 54.5% |
| -150 | 60.0% |
| -200 | 66.7% |

### Win Rate → Edge (at -110)

| Win% | Edge |
|------|------|
| 52.4% | Break even |
| 53.5% | ~2% |
| 55.0% | ~5% |
| 57.0% | ~8.9% |
| 60.0% | ~14.6% |

---

## BET SIZING (KELLY)

```
MinWin:     $___
MinEdge:    ___%  (recommended: 5%)
Bankroll:   $___
Edge:       ___%

Bet multiplier = edge / MinEdge = ___×
Bet size = (multiplier × MinWin) adjusted for odds

Rule: MinWin = 1.5–2.5% of bankroll at 5% MinEdge
      → $200 MinWin per $10,000 bankroll

Safety check: all simultaneous bets < 25% bankroll
```

### Sizing by Terms (MinWin = $100 example)

| Terms | Bet Size |
|-------|----------|
| -110 | $110 |
| -160 | $160 |
| +125 | $80 |
| 10:1 | $10 |
| 20:1 | $5 |

### Parlay Sizing

| Type | Terms | Bet (for $100 MinWin) |
|------|-------|-----------------------|
| 2-team | 13:5 | $38 |
| 3-team | 6:1 | $17 |
| Futures/long shot | 50:1 | $2 per point of edge |

---

## EDGE SOURCE DETAIL

| Source | What You Know | Why Market Wrong |
|--------|--------------|-----------------|
| Breaking news | | |
| Superior data processing | | |
| Motivation / situational | | |
| Fan money (fade public) | | |

### Edge Source Examples

**Breaking News:** Injury not public yet, weather shift, coaching change, suspension
**Superior Data:** Power ratings in illiquid market, conference expertise, overcompensation after big win/loss
**Motivation:** Team clinched (fade), must-win game (back), horrible defeat syndrome (fade next week)
**Fan Money:** Heavy public side on Super Bowl, NBA playoffs, marquee fights → take unpopular side at inflated value

---

## RED FLAGS — KILL BET IF ANY TRUE

- [ ] Can't articulate WHY you have edge
- [ ] Big favorite -400 or worse
- [ ] Teaser not crossing both 3 AND 7
- [ ] Parlay card with "ties lose"
- [ ] Season win bet, projection differs <2 games (6-month sport)
- [ ] Futures ROI won't compensate capital lock-up
- [ ] Emotional attachment to pick
- [ ] No statistical significance (see Part 4 thresholds)

---

## BET RECORD

| Field | Value |
|-------|-------|
| Date | |
| Sport | |
| Game | |
| Bet type | Spread / ML / Total / Prop / Teaser / Parlay |
| Your line estimate | |
| Actual line taken | |
| Terms / Odds | |
| Book used | |
| Bet size | |
| Your est. win prob | |
| Break-even prob | |
| Edge % | |
| Result | W / L / P |
| Net +/- | |

---

## PROP BET ADDON (POISSON)

Use when event is countable one-at-a-time (sacks, FGs, TDs, HRs, 3-pointers).
Do NOT use for yards, points scored, penalty yards.

```
Event:          ___________
Predicted mean: ___
Prop line:      O/U ___
P(under):       ___% (from Poisson cumulative table at mean)
P(over):        ___%
P(push):        ___%
Book odds:      ___
Edge:           ___%
```

### Quick Poisson Reference

| Mean | P(0) | P(1) | P(2) | P(3) | P(4) | P(5) |
|------|------|------|------|------|------|------|
| 0.4 | 67% | 27% | 5% | 1% | — | — |
| 1.2 | 30% | 36% | 22% | 9% | 3% | 1% |
| 2.2 | 11% | 24% | 27% | 20% | 11% | 5% |
| 2.5 | 8% | 21% | 26% | 21% | 13% | 7% |
| 4.0 | 2% | 7% | 15% | 20% | 20% | 16% |
| 4.7 | 1% | 4% | 10% | 16% | 19% | 17% |

---

## NFL TEASER CHECKLIST

Only profitable teaser: points cross BOTH 3 and 7.

| Criteria | Check |
|----------|-------|
| 6pt teaser: team at -7.5 to -8.5 or +1.5 to +2.5? | YES / NO |
| Crosses both 3 AND 7? | YES / NO |
| NOT visiting favorite? (63% cover = avoid) | YES / NO |
| Teams NOT in same game? | YES / NO |
| Book doesn't strip key numbers with "off" lines? | YES / NO |

### Teaser Break-Even

| Type | Terms | Need Cover % | Historical Cover % |
|------|-------|-------------|-------------------|
| 2-team 6pt | -110 | 72.4% | 73.2% |
| 2-team 6.5pt | -120 | 73.9% | 74.0% |
| 2-team 7pt | -130 | 75.2% | 74.2% |

---

## LINE SHOPPING PRIORITY

1. Half-point off key number (3, 7)? → Take it
2. -105 available vs -110? → Use it (+2.2% EV)
3. ML better than spread? → Compare using spread/ML table
4. Correlated parlay opportunity? → Consider it

---

## POST-BET REVIEW (MONTHLY)

```
Total bets:        ___
Win rate:          ___%
Net winnings:      $___
Total action:      $___
Actual edge:       net / action = ___%
Effective win%:    (edge × 1.91 + 100) = ___%

Statistical significance check:
  Need √n excess wins for 2 SD significance
  Current sample:    ___ bets
  Need excess wins:  ___
  Actual excess:     ___
  Significant?:      YES / NO
```

### Significance Thresholds

| Sample | 1:100 | 1:1000 | 1:10,000 |
|--------|-------|--------|----------|
| 20 | 15-5 | 18-2 | — |
| 55 | 35-20 | — | — |
| 100 | 60-40 | 66-34 | — |
| 250 | — | 150-100 | — |

**Rule:** Never use games that formed hypothesis to test it. Hold to 1:1000 minimum.

---

*Template derived from Sharp Sports Betting by Stanford Wong, Pi Yee Press*
