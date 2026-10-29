import {useState} from 'react';
import {useGetChannelCatalogQuery} from '@/api/baseApi';
import {MESSAGE_FEATURE_LABELS} from '@/api/channel-catalog';
import {describeError} from '@/api/errors';
import {Alert,Button,Field,LoadingState,uiStyles} from '@/components/ui';

const states={supported:'Доступно',unsupported:'Недоступно',unknown:'Не проверено'} as const;

export function ChannelCatalog({onAddTelegram}:{onAddTelegram:()=>void}){
 const [open,setOpen]=useState(false),[filter,setFilter]=useState('');
 const query=useGetChannelCatalogQuery(undefined,{skip:!open});
 const items=query.data?.items.filter(item=>(item.name+' '+item.family).toLocaleLowerCase().includes(filter.toLocaleLowerCase()))??[];
 return <details onToggle={event=>setOpen(event.currentTarget.open)}>
  <summary>Мессенджеры и возможности</summary>
  <p className={uiStyles.muted}>Telegram, WhatsApp и другие каналы подключаются отдельно. Возможности проверяются для каждого подключения и направления.</p>
  {query.isLoading?<LoadingState label="Загружаем каталог мессенджеров…"/>:null}
  {query.isError?<Alert tone="error" title="Каталог недоступен">{describeError(query.error)}</Alert>:null}
  {query.data?<>
   <Field id="channel-catalog-search" label="Найти мессенджер"><input id="channel-catalog-search" className={uiStyles.input} value={filter} onChange={event=>setFilter(event.target.value)}/></Field>
   <ul>{items.map(item=><li key={item.id}>
    <details><summary>{item.name} — {item.implementation==='adapter'?'Требуется подключение':'Подключение готовится'}</summary>
     <p>Для amoCRM используется отдельный канал связи. Возможности ниже ещё не подтверждены для вашего подключения.</p>
     <table><thead><tr><th>Возможность</th><th>Отправка</th><th>Приём</th></tr></thead><tbody>
      {Object.entries(MESSAGE_FEATURE_LABELS).map(([key,label])=>{const capability=item.capabilities[key as keyof typeof MESSAGE_FEATURE_LABELS];return <tr key={key}><th scope="row">{label}</th><td>{states[capability.send]}</td><td>{states[capability.receive]}</td></tr>;})}
     </tbody></table>
     {item.setupAvailable?<Button onClick={onAddTelegram}>Настроить Telegram-бота</Button>:null}
    </details>
   </li>)}</ul>
   {!items.length?<p>Мессенджер не найден. Другой сервис можно добавить через отдельный адаптер.</p>:null}
  </>:null}
 </details>;
}
