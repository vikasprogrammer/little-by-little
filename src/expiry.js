export const DAY=86400000;
export const isExpired=(task,now)=>task.expiresAt<=now;
export const canBump=(task,now)=>task.expiresAt>now&&task.expiresAt-now<=5*DAY;
export const matchesView=(task,view,now)=>view==='expired'
 ?isExpired(task,now)
 :!isExpired(task,now)&&(view==='all'||(view==='today'?task.today:task.important));
