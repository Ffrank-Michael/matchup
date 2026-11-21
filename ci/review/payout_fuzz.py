# Mirror of PredictionArena payout maths (integers), fuzzed for solvency and dust behaviour.
import random
FEE, BPS = 200, 10_000
def matchedFor(s,M,T,onBig,bigWon):
    if not onBig: return s,0
    ex=s*M; base=ex//T
    m = base if bigWon else (base if ex%T==0 else base+1)
    return m, s-m
def payout(upWon,U,D,up,down):
    M=min(U,D); T=max(U,D); F=M*FEE//BPS; Dist=M-F
    stake = up if upWon else down
    if stake:
        onBig = (U>D) if upWon else (D>U)
        m,_=matchedFor(stake,M,T,onBig,True)
        return stake + m*Dist//M, 'W', stake
    ls = down if upWon else up
    if ls==0: return 0,'-',0
    lob = (D>U) if upWon else (U>D)
    if not lob: return 0,'L0',ls
    _,un=matchedFor(ls,M,T,True,False)
    return un,'L',ls
worst_short=0; stuck_cases=0; maxstuck=0; rounds=0
for it in range(200000):
    n=random.randint(2,8)
    players=[]
    for i in range(n):
        s=random.choice([500000,random.randint(500000,5_000_000),random.randint(500000,10**9)])
        players.append((random.random()<0.5, s))
    U=sum(s for u,s in players if u); D=sum(s for u,s in players if not u)
    if U==0 or D==0: continue
    rounds+=1
    upWon=random.random()<0.5
    M=min(U,D); F=M*FEE//BPS; Dist=M-F
    paid=0; fees=F
    # winner dust tracking
    wsc=0; bonus=0; lmc=0; lsc=0
    for u,s in players:
        p,k,st=payout(upWon,U,D,s if u else 0,0 if u else s)
        if p==0: continue   # NothingToClaim revert: not tracked
        paid+=p
        if k=='W':
            wsc+=st; bonus+=p-st
            if wsc==(U if upWon else D): fees+=Dist-bonus
        elif k=='L':
            m,_=matchedFor(st,M,max(U,D),True,False); lmc+=m; lsc+=st
            if lsc==(D if upWon else U) and lmc>M: fees+=lmc-M
    total=U+D
    if paid+fees>total: worst_short=max(worst_short,paid+fees-total)
    left=total-paid-fees
    if left>0: stuck_cases+=1; maxstuck=max(maxstuck,left)
print("rounds",rounds,"insolvent cases (max shortfall micro-USDC):",worst_short)
print("rounds leaving unbooked dust:",stuck_cases,"max dust micro-USDC:",maxstuck)
