const users=document.getElementById("usersOnline")
const speed=document.getElementById("networkSpeed")
const sold=document.getElementById("bundlesSold")
const load=document.getElementById("networkLoad")

const STATS_BACKEND="https://backend-ut99.onrender.com";

async function fetchStats(){
  try{
    const res=await fetch(`${STATS_BACKEND}/stats`);
    if(!res.ok) return;
    const data=await res.json();
    if(!data.success) return;
    if(users) users.innerText=data.total;
    if(sold) sold.innerText=data.soldToday;
    if(load) load.innerText=data.allocated;
    if(speed) speed.innerText="Live";
  }catch(e){}
}

fetchStats();
setInterval(fetchStats,10000);



/* FAKE PURCHASES */

const names=["John","Asha","Kelvin","Maria","Ali","Fatma"]
const cities=["Dar","Arusha","Mwanza","Dodoma"]

function purchase(){

const name=names[Math.floor(Math.random()*names.length)]
const city=cities[Math.floor(Math.random()*cities.length)]

const box=document.createElement("div")

box.innerText=`🟢 ${name} from ${city} purchased 7GB`

box.style.position="fixed"
box.style.bottom="20px"
box.style.left="20px"
box.style.background="#111"
box.style.padding="10px"
box.style.borderRadius="10px"

document.body.appendChild(box)

setTimeout(()=>box.remove(),4000)

}

setInterval(purchase,5000)