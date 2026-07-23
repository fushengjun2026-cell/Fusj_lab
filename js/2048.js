const gameBoard=document.querySelector("#game-2048-board");
const scoreValue=document.querySelector("#score-value");
const bestValue=document.querySelector("#best-value");
const gameMessage=document.querySelector("#game-2048-message");
const undoButton=document.querySelector("#undo-2048");
const undoCount=document.querySelector("#undo-count");
const resetGameButton=document.querySelector("#reset-2048");
const size=4;
let grid=[];
let score=0;
let best=Number(localStorage.getItem("cosmic-2048-best")||0);
let history=[];
let gameOver=false;
let touchStart=null;
let animating=false;
let tileIdCounter=0;
let tileLayer=null;
let tileEls=new Map();
let tileData=new Map();

const SAVE_KEY="cosmic-2048-save";
const SLIDE_MS=130;

function saveGame(){try{localStorage.setItem(SAVE_KEY,JSON.stringify({grid,score,history,gameOver}))}catch(e){}}
function loadGame(){try{const raw=localStorage.getItem(SAVE_KEY);if(!raw)return false;const data=JSON.parse(raw);if(!data.grid||data.grid.length!==size)return false;grid=data.grid.map(r=>r.slice());score=data.score||0;history=Array.isArray(data.history)?data.history:[];gameOver=!!data.gameOver;return true}catch(e){return false}}
function clearSave(){try{localStorage.removeItem(SAVE_KEY)}catch(e){}}

function emptyGrid(){return Array.from({length:size},()=>Array(size).fill(0))}
function copyGrid(source){return source.map(row=>row.slice())}

/* ---- Board setup: background cells + tile layer ---- */
function initBoard(){
if(!gameBoard)return;
gameBoard.innerHTML="";
for(let i=0;i<size*size;i++){const cell=document.createElement("div");cell.className="game-2048-cell";gameBoard.append(cell)}
tileLayer=document.createElement("div");
tileLayer.className="tile-layer";
gameBoard.append(tileLayer);
}

/* ---- Positioning helpers ---- */
function cellMetrics(){
const rect=gameBoard.getBoundingClientRect();
const cs=getComputedStyle(gameBoard);
const pad=parseFloat(cs.paddingLeft)||10;
const gap=parseFloat(cs.gap)||parseFloat(cs.rowGap)||10;
const inner=rect.width-pad*2;
const cell=(inner-gap*(size-1))/size;
return{pad,gap,cell};
}
function posFor(row,col){
const{pad,gap,cell}=cellMetrics();
return{x:pad+col*(cell+gap),y:pad+row*(cell+gap),s:cell};
}

/* ---- Tile DOM management ---- */
function createTileEl(id,value,row,col,spawn){
const el=document.createElement("div");
el.className=`game-2048-tile tile-${value}`;
el.textContent=value;
el.dataset.id=id;
const p=posFor(row,col);
el.style.width=p.s+"px";
el.style.height=p.s+"px";
el.style.transform=`translate(${p.x}px,${p.y}px)`;
if(spawn){el.style.transition="none";el.classList.add("tile-spawn")}
tileLayer.append(el);
if(spawn){requestAnimationFrame(()=>{requestAnimationFrame(()=>{el.style.transition=""})})}
tileEls.set(id,el);
return el;
}
function positionTileEl(el,row,col){
const p=posFor(row,col);
el.style.width=p.s+"px";
el.style.height=p.s+"px";
el.style.transform=`translate(${p.x}px,${p.y}px)`;
}
function removeTileEl(id){
const el=tileEls.get(id);
if(el){el.remove();tileEls.delete(id)}
tileData.delete(id);
}

/* ---- Sync tiles from grid (instant, no animation) ---- */
function syncTilesFromGrid(){
tileEls.forEach(el=>el.remove());
tileEls.clear();
tileData.clear();
for(let row=0;row<size;row++)for(let col=0;col<size;col++){
const value=grid[row][col];
if(!value)continue;
const id=++tileIdCounter;
tileData.set(id,{value,row,col});
createTileEl(id,value,row,col,false);
}
}

/* ---- Animated move ---- */
function animatedMove(direction){
if(gameOver||animating)return;
const before=copyGrid(grid),beforeScore=score;

/* Build line data with tile tracking */
const movements=[];/* {id,fromRow,fromCol,toRow,toCol} */
const merges=[];/* {id1,id2,toRow,toCol,newValue} */
let gained=0;

/* Map current grid positions to tile ids */
const posToId=new Map();
tileData.forEach((d,id)=>posToId.set(d.row+","+d.col,id));

for(let index=0;index<size;index++){
/* Extract line of {value,id} in movement order */
const line=[];
for(let offset=0;offset<size;offset++){
const row=direction==="up"?offset:direction==="down"?size-1-offset:index;
const col=direction==="left"?offset:direction==="right"?size-1-offset:index;
const value=grid[row][col];
const id=posToId.get(row+","+col)||null;
line.push({value,id,row,col});
}
/* Compress with tracking */
const items=line.filter(c=>c.value!==0);
const result=[];
let i=0;
while(i<items.length){
if(i+1<items.length&&items[i].value===items[i+1].value){
const newValue=items[i].value*2;
gained+=newValue;
/* target position */
const tOffset=result.length;
const tRow=direction==="up"?tOffset:direction==="down"?size-1-tOffset:index;
const tCol=direction==="left"?tOffset:direction==="right"?size-1-tOffset:index;
merges.push({id1:items[i].id,id2:items[i+1].id,toRow:tRow,toCol:tCol,newValue});
result.push({value:newValue,merged:true});
i+=2;
}else{
const tOffset=result.length;
const tRow=direction==="up"?tOffset:direction==="down"?size-1-tOffset:index;
const tCol=direction==="left"?tOffset:direction==="right"?size-1-tOffset:index;
if(items[i].id)movements.push({id:items[i].id,fromRow:items[i].row,fromCol:items[i].col,toRow:tRow,toCol:tCol});
result.push({value:items[i].value,merged:false});
i++;
}
}
while(result.length<size)result.push({value:0,merged:false});
/* Write back to grid */
for(let offset=0;offset<size;offset++){
const row=direction==="up"?offset:direction==="down"?size-1-offset:index;
const col=direction==="left"?offset:direction==="right"?size-1-offset:index;
grid[row][col]=result[offset].value;
}
}

const changed=grid.some((row,r)=>row.some((v,c)=>v!==before[r][c]));
if(!changed){setMessage(gameOver?"The board is full. Undo a move to continue.":"No signal moved in that direction.");return}

history.push({grid:before,score:beforeScore});
score+=gained;
if(score>best){best=score;localStorage.setItem("cosmic-2048-best",String(best))}

/* Animate */
animating=true;

/* Slide existing tiles */
movements.forEach(m=>{
const el=tileEls.get(m.id);
if(el)positionTileEl(el,m.toRow,m.toCol);
tileData.get(m.id).row=m.toRow;
tileData.get(m.id).col=m.toCol;
});

/* Slide merge sources to target, then pop */
merges.forEach(m=>{
const el1=tileEls.get(m.id1);
const el2=tileEls.get(m.id2);
if(el1)positionTileEl(el1,m.toRow,m.toCol);
if(el2)positionTileEl(el2,m.toRow,m.toCol);
});

setTimeout(()=>{
/* Remove merge sources, create merged tile */
merges.forEach(m=>{
removeTileEl(m.id1);
removeTileEl(m.id2);
const id=++tileIdCounter;
tileData.set(id,{value:m.newValue,row:m.toRow,col:m.toCol});
createTileEl(id,m.newValue,m.toRow,m.toCol,false);
});

/* Add new random tile */
const empty=[];
for(let row=0;row<size;row++)for(let col=0;col<size;col++)if(grid[row][col]===0)empty.push([row,col]);
if(empty.length){
const[row,col]=empty[Math.floor(Math.random()*empty.length)];
grid[row][col]=Math.random()<.9?2:4;
const id=++tileIdCounter;
tileData.set(id,{value:grid[row][col],row,col});
createTileEl(id,grid[row][col],row,col,true);
}

updateHUD();
if(!hasMoves())gameOver=true;
setMessage(gameOver?"The board is full. Undo a move to continue.":gained?`Merged signal +${gained}.`:"Signal shifted.");
saveGame();
animating=false;
},SLIDE_MS+20);
}

/* ---- Game logic (unchanged) ---- */
function hasMoves(){if(grid.some(row=>row.includes(0)))return true;for(let row=0;row<size;row++)for(let col=0;col<size;col++){if(row<size-1&&grid[row][col]===grid[row+1][col])return true;if(col<size-1&&grid[row][col]===grid[row][col+1])return true}return false}
function setMessage(message){if(gameMessage)gameMessage.textContent=message}
function updateHUD(){if(scoreValue)scoreValue.textContent=score;if(bestValue)bestValue.textContent=best;if(undoCount)undoCount.textContent=history.length;if(undoButton)undoButton.disabled=!history.length}

function draw(){if(!gameBoard)return;syncTilesFromGrid();updateHUD();saveGame()}
function undo(){if(!history.length){setMessage("Nothing to undo yet.");return}const previous=history.pop();grid=copyGrid(previous.grid);score=previous.score;gameOver=false;draw();setMessage("Move restored. Choose another orbit.")}
function newGame(){clearSave();grid=emptyGrid();score=0;history=[];gameOver=false;
const empty=[];for(let r=0;r<size;r++)for(let c=0;c<size;c++)empty.push([r,c]);
for(let i=0;i<2;i++){const[r,c]=empty.splice(Math.floor(Math.random()*empty.length),1)[0];grid[r][c]=Math.random()<.9?2:4}
draw();setMessage("Use the arrow keys, buttons, or swipe to begin.")}

function handleDirection(direction){animatedMove(direction)}

/* ---- Event bindings ---- */
document.querySelectorAll("[data-move]").forEach(button=>button.addEventListener("click",()=>handleDirection(button.dataset.move)));
undoButton?.addEventListener("click",undo);
resetGameButton?.addEventListener("click",newGame);
addEventListener("keydown",event=>{const keys={ArrowUp:"up",ArrowDown:"down",ArrowLeft:"left",ArrowRight:"right",w:"up",s:"down",a:"left",d:"right"};if(event.key==="Escape"){undo();return}if(keys[event.key]){event.preventDefault();handleDirection(keys[event.key])}});
gameBoard?.addEventListener("touchstart",event=>{event.preventDefault();const touch=event.changedTouches[0];touchStart=[touch.clientX,touch.clientY]},{passive:false});
gameBoard?.addEventListener("touchmove",event=>{event.preventDefault()},{passive:false});
gameBoard?.addEventListener("touchend",event=>{event.preventDefault();if(!touchStart)return;const touch=event.changedTouches[0],dx=touch.clientX-touchStart[0],dy=touch.clientY-touchStart[1];touchStart=null;if(Math.max(Math.abs(dx),Math.abs(dy))<28)return;handleDirection(Math.abs(dx)>Math.abs(dy)?dx>0?"right":"left":dy>0?"down":"up")},{passive:false});

/* Reposition tiles on resize */
let resizeTimer;
addEventListener("resize",()=>{clearTimeout(resizeTimer);resizeTimer=setTimeout(()=>{tileData.forEach((d,id)=>{const el=tileEls.get(id);if(el)positionTileEl(el,d.row,d.col)})},100)});

/* ---- Init ---- */
initBoard();
if(loadGame()){syncTilesFromGrid();updateHUD();setMessage(gameOver?"The board is full. Undo a move to continue.":"Welcome back — your orbit is restored.")}else{newGame()}
