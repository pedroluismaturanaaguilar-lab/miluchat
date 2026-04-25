const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");

const app = express();

/* Render/Proxy */
app.set("trust proxy", 1);

const server = http.createServer(app);

const io = new Server(server,{
  cors:{
    origin:"*",
    methods:["GET","POST"]
  }
});

app.use(express.static(path.join(__dirname)));

app.get("/",(req,res)=>{
 res.sendFile(path.join(__dirname,"index.html"));
});

/* filtro */
const badWords = [
'puto','puta','mierda','coño','joder',
'idiota','pendejo','imbécil'
];

function filterMessage(text){
 let t=text;
 badWords.forEach(word=>{
   let r=new RegExp(`\\b${word}\\b`,"gi");
   t=t.replace(r,"****");
 });
 return t;
}

const users = new Map();
const userSockets = new Map();
const privateRooms = new Map();

function broadcastUsers(){
 io.emit(
   "user list",
   Array.from(users.values())
 );
}

io.on("connection",(socket)=>{

 console.log("Conectado:",socket.id);

 socket.on("set username",(username,callback)=>{

   if(!username || username.trim()===""){
      return callback(false,"Nombre inválido");
   }

   let exists=[...users.values()]
      .includes(username);

   if(exists){
      return callback(false,"Nombre ocupado");
   }

   users.set(socket.id,username);
   userSockets.set(username,socket.id);

   socket.username=username;

   socket.join("global");

   callback(true);

   socket.broadcast.emit(
     "system message",
     {
      text:`✨ ${username} se ha unido`,
      timestamp:Date.now()
     }
   );

   broadcastUsers();

 });

 socket.on("chat message",({text,room})=>{

   if(!socket.username || !text) return;

   const data={
      type:"text",
      username:socket.username,
      text:filterMessage(text),
      timestamp:Date.now()
   };

   if(room && room!=="global"){
      io.to(room).emit(
         "private message",
         data
      );
   }else{
      io.to("global").emit(
         "chat message",
         data
      );
   }

 });

 socket.on("media message",({mediaType,content,room})=>{

   if(!socket.username) return;

   const data={
      type:mediaType,
      content,
      username:socket.username,
      timestamp:Date.now()
   };

   if(room && room!=="global"){
      io.to(room).emit(
       "private message",
       data
      );
   }else{
      io.to("global").emit(
       "chat message",
       data
      );
   }

 });

 socket.on(
 "start private chat",
 ({targetUsername},callback)=>{

 let targetId=userSockets.get(targetUsername);

 if(!targetId){
   return callback({
      success:false,
      error:"Usuario offline"
   });
 }

 let p=[
 socket.username,
 targetUsername
 ].sort();

 let room=`private_${p[0]}_${p[1]}`;

 if(!privateRooms.has(room)){
   privateRooms.set(room,{
      participants:p
   });
 }

 socket.join(room);

 let other=io.sockets.sockets.get(targetId);

 if(other){
   other.join(room);
 }

 callback({
  success:true,
  roomName:room
 });

 });

 socket.on("logout",()=>{
   socket.disconnect(true);
 });

 socket.on("disconnect",()=>{

   if(socket.username){

      let name=socket.username;

      users.delete(socket.id);
      userSockets.delete(name);

      io.emit(
       "system message",
       {
         text:`⚠️ ${name} salió`,
         timestamp:Date.now()
       }
      );

      broadcastUsers();
   }

 });

});

const PORT=process.env.PORT || 3000;

server.listen(PORT,()=>{
 console.log("Servidor activo puerto "+PORT);
});