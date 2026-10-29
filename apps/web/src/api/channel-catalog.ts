export const MESSAGE_FEATURE_LABELS={text:'Текст',photo:'Фото',document:'Документы',video:'Видео',audio:'Аудио',voice:'Голосовые',
 animation:'Анимации',sticker:'Стикеры',videoNote:'Видеосообщения',contact:'Контакты',location:'Геолокация',poll:'Опросы',
 buttons:'Кнопки',reply:'Ответ на сообщение',forward:'Пересылки',reaction:'Реакции',edit:'Редактирование',delete:'Удаление',
 typing:'Набор текста',delivery:'Доставка',read:'Прочтение',history:'История',groups:'Группы',topics:'Темы',
 audioCall:'Аудиозвонки',videoCall:'Видеозвонки'} as const;
type CapabilityState='supported'|'unsupported'|'unknown';
export type ChannelCatalogItem={id:string;name:string;family:string;connectionType:string;implementation:'adapter'|'planned';
 requiresSeparateCrmChannel:true;setupAvailable:boolean;verification:'unverified';
 capabilities:Record<keyof typeof MESSAGE_FEATURE_LABELS,{send:CapabilityState;receive:CapabilityState}>};
export type ChannelCatalogResponse={schemaVersion:1;items:ChannelCatalogItem[]};
