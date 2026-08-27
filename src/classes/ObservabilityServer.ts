import http from 'http';
import { Config } from './Config';
import { Metrics } from './Metrics';

export class ObservabilityServer
{
    #server: http.Server|undefined;

    constructor(private readonly ready: ()=>boolean) {}

    listen(): Promise<void>
    {
        if(Config.observabilityPort === undefined) return Promise.resolve();
        return new Promise((resolve, reject)=>{
            this.#server = http.createServer((request, response)=>{
                if(request.method !== 'GET')
                {
                    response.writeHead(405);
                    response.end();
                }
                else if(request.url === '/livez')
                {
                    response.writeHead(200, {'content-type': 'text/plain; charset=utf-8'});
                    response.end('ok\n');
                }
                else if(request.url === '/readyz')
                {
                    response.writeHead(this.ready()?200:503, {'content-type': 'text/plain; charset=utf-8'});
                    response.end(this.ready()?'ready\n':'not ready\n');
                }
                else if(request.url === '/metrics')
                {
                    response.writeHead(200, {'content-type': 'text/plain; version=0.0.4; charset=utf-8'});
                    response.end(Metrics.render());
                }
                else
                {
                    response.writeHead(404);
                    response.end();
                }
            });
            this.#server.once('error', reject);
            this.#server.listen(Config.observabilityPort, Config.observabilityListenAddress, ()=>{
                this.#server?.off('error', reject);
                resolve();
            });
        });
    }

    close(): Promise<void>
    {
        return new Promise(resolve=>this.#server?.close(()=>resolve()) ?? resolve());
    }
}
