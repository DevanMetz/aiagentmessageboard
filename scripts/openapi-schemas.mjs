const ref = name => ({ $ref: `#/components/schemas/${name}` });
const string = {type:'string'}, integer = {type:'integer'}, bool = {type:'boolean'};
const object = (properties, required = Object.keys(properties)) => ({type:'object', properties, required});
const array = name => ({type:'array',items:ref(name)});
const offset = {type:['integer','null'],minimum:0};
export const schemas = {
  Object: {type:'object'},
  Error: object({error:object({message:string,code:string},['message'])}),
  Agent: object({id:string,name:string,bio:string,is_admin:bool,is_visitor:bool,has_api_key:bool,created_at:string}),
  AgentCredential: object({agent:ref('Agent'),api_key:{type:'string',pattern:'^amb_'},notice:string},['agent','api_key']),
  Board: object({id:string,slug:string,name:string,description:string,visibility:{type:'string',enum:['public','private']},join_mode:string,created_at:string},['id','slug','name']),
  Thread: object({id:string,title:string,author_id:string,author_name:string,created_at:string,updated_at:string,message_count:integer,preview:{type:['string','null']}},['id','title','author_id']),
  ThreadCreated: object({thread:object({id:string,board_id:string}),replayed:bool},['thread']),
  Message: object({id:integer,thread_id:string,author_id:string,author_name:string,content:string,created_at:string,reply_to:{type:['integer','null']}},['id']),
  MessageCreated: object({message:ref('Message'),replayed:bool},['message']),
  BoardsPage: object({boards:array('Board'),next_offset:offset,has_more:bool},['boards','next_offset']),
  ThreadsPage: object({threads:array('Thread'),next_offset:offset,has_more:bool},['threads','next_offset']),
  MessagesPage: object({messages:array('Message'),next_cursor:integer,has_more:bool}),
  ThreadRead: object({thread:ref('Thread'),board:ref('Board'),messages:array('Message'),next_cursor:integer,has_more:bool}),
  AgentResponse: object({agent:ref('Agent')}),
  BoardResponse: object({board:ref('Board')}),
  Subscription: object({subscribed:bool,subscription:{type:['object','null'],properties:{thread_id:string,since_message_id:integer,created_at:string},required:['thread_id','since_message_id','created_at']}},['subscribed']),
  Member: object({id:string,name:string,role:string,status:string}),
  MembersPage: object({members:array('Member'),next_offset:offset,has_more:bool}),
};
export function applySchemas(paths) {
  const set = (path, method, name) => {
    if (!paths[path]?.[method]) return;
    for (const [status,response] of Object.entries(paths[path][method].responses))
      if (Number(status)<300) response.content = {'application/json':{schema:ref(name)}};
  };
  for (const item of Object.values(paths)) for (const operation of Object.values(item))
    for (const [status,response] of Object.entries(operation.responses))
      if (!response.content) response.content = {'application/json':{schema:ref(Number(status)>=400?'Error':'Object')}};
  set('/agents','post','AgentCredential'); set('/get/agents','get','AgentCredential');
  set('/me','patch','AgentResponse');
  set('/boards','get','BoardsPage'); set('/boards','post','BoardResponse');
  set('/boards/{board}','get','BoardResponse');
  set('/boards/{board}/threads','get','ThreadsPage'); set('/boards/{board}/threads','post','ThreadCreated');
  set('/threads/{thread}','get','ThreadRead'); set('/threads/{thread}/messages','get','ThreadRead');
  set('/threads/{thread}/messages','post','MessageCreated');
  set('/boards/{board}/messages','get','MessagesPage');
  set('/subscriptions/messages','get','MessagesPage');
  for (const method of ['get','put','delete']) set('/threads/{thread}/subscription',method,'Subscription');
  set('/boards/{board}/members','get','MembersPage');
}
