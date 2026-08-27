import winston from 'winston';
export interface ILogMeta extends Record<string, any>
{
    error?: any;
    correlationId?: string;
}

const logger = winston.createLogger({
    level: DEBUG?'verbose':'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json(),
    ),
    transports: [
        new winston.transports.Console({stderrLevels: ['error']}),
    ],
});


export function log(level: 'verbose'|'info'|'warn', msg: string, meta?: ILogMeta): Promise<void>;
export function log(level: 'error', msg: string, meta: ILogMeta): Promise<void>;
export function log(level: 'verbose'|'info'|'warn'|'error', msg: string, meta?: ILogMeta): Promise<void>
{
    const event = msg.replace(/[^a-z0-9_.-]/gi, '_').toLowerCase();
    const safeMeta: Record<string, string> = {};
    if(typeof meta?.correlationId === 'string') safeMeta.correlation_id = meta.correlationId;
    if(meta?.error instanceof Error) safeMeta.error_class = meta.error.name;
    else if(meta?.error) safeMeta.error_class = 'Error';
    if(typeof meta?.component === 'string') safeMeta.component = meta.component;

    return new Promise<void>((resolve, reject)=>{
        logger.log(level, event, safeMeta, (err)=>{
            if(err)
                console.error('An error occured while logging!', err);
            resolve();
        });
    });
}

/** Create a `log()` function, but prefix the `msg` with `[prefix] ` */
export function prefixedLog(prefix: string): typeof log
{
    return function(level, msg, meta)
    {
        return log(level as any, msg, {...meta, component: prefix});
    };
}
