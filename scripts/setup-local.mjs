import {existsSync,writeFileSync} from 'node:fs';
import {randomBytes,scryptSync,createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const envFile=fileURLToPath(new URL('../.env.local',import.meta.url));
const credentialsFile=fileURLToPath(new URL('../.local-credentials.json',import.meta.url));
if(existsSync(envFile)||existsSync(credentialsFile)){
 console.log('Local configuration already exists. It has been preserved.');
 process.exit(0);
}
const password=randomBytes(18).toString('base64url');
const salt=randomBytes(16).toString('hex');
const token='lbl_'+randomBytes(32).toString('base64url');
const session=randomBytes(32).toString('hex');
const hash=scryptSync(password,salt,64).toString('hex');
const tokenHash=createHash('sha256').update(token).digest('hex');
writeFileSync(envFile,`NODE_ENV=development\nPORT=3000\nAPP_ORIGIN=http://localhost:3000\nBOARD_PASSWORD_HASH=${salt}:${hash}\nBOARD_SESSION_KEY=${session}\nBOARD_MCP_TOKEN_HASH=${tokenHash}\n`,{mode:0o600,flag:'wx'});
writeFileSync(credentialsFile,JSON.stringify({boardUrl:'http://localhost:3000',boardPassword:password,mcpUrl:'http://localhost:3000/mcp',agentToken:token},null,2)+'\n',{mode:0o600,flag:'wx'});
console.log('Local setup complete. Open .local-credentials.json for your local password and agent token.');
