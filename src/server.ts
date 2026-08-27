import { Config } from './classes/Config';
import { log } from './classes/Logger';
import { MailQueue } from './classes/MailQueue';
import { SMTPServer } from './classes/SMTPServer';
import { ObservabilityServer } from './classes/ObservabilityServer';

if(process.argv.includes('-v') || process.argv.includes('--version')) // We're asked for our version?
    console.log(`SMTP2Graph v${VERSION}`);
else
{
    (async ()=>{
        // Validate the config before continuing
        try {
            Config.validate();
        } catch(error) {
            await log('error', 'gateway_config_invalid', {error});
            process.exit(1);
        }

        const queue = new MailQueue();
        const server = new SMTPServer(queue);
        try {
            let ready = false;
            const observabilityServer = new ObservabilityServer(()=>ready);
            await observabilityServer.listen();
            await server.listen();
            ready = true;
        } catch(error) {
            log('error', 'gateway_start_failed', {error});
            process.exit(1);
        }
    })();
}

// Exit with code 0 on Ctrl+C
process.on('SIGINT', ()=>{
    process.exit(0);
});

// Exit with code 0 when container is stopped
process.on('SIGTERM', ()=>{
    process.exit(0);
});
